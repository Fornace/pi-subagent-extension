/** Persistent RPC child management; prompt completion is not process exit. */
import { spawn } from "node:child_process";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { assertManagedRuntime } from "./agent-runtime.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Workspace } from "./workspace.ts";
import { generateHandle, getPiInvocation, getFinalOutput, emptyUsage, rpcSend,
  attachJsonlReader, type AgentSpawnConfig, type ManagedAgent, type AgentEvent,
  type AgentStatusInfo } from "./agent-manager-support.ts";
export type { AgentSpawnConfig, AgentState, UsageStats, ManagedAgent, AgentEvent,
  AgentStatusInfo } from "./agent-manager-support.ts";
import { waitForPrompt } from "./agent-wait.ts";
import { sendPrompt, observePromptResponse } from "./agent-rpc-prompts.ts";

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  private agents = new Map<string, ManagedAgent>();

  /** Spawn a new child agent. Returns the handle immediately; the agent runs in background. */
  spawn(config: AgentSpawnConfig): string {
    assertManagedRuntime(VERSION);
    const handle = generateHandle(config.agentName);

    // Build CLI args
    const invocation = getPiInvocation();
    const args = [...invocation.args, "--mode", "rpc", "--no-session"];
    if (config.model) args.push("--model", config.model);
    if (config.tools?.length) args.push("--tools", config.tools.join(","));

    // Write system prompt + workspace instructions to temp file
    let tmpPromptPath: string | null = null;
    const systemPromptParts: string[] = [];
    if (config.systemPrompt) systemPromptParts.push(config.systemPrompt);
    if (config.workspace) {
      systemPromptParts.push(
        `\n## Shared Workspace\nYour workspace directory is: ${config.workspace.path}\n` +
        `Write findings to: ${config.workspace.path}/findings.md\n` +
        `Write structured data to: ${config.workspace.path}/state.json\n` +
        `Other agents may read these files to coordinate with you.\n` +
        `Use read/write/bash tools to access workspace files.`
      );
    }
    if (systemPromptParts.length > 0) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-prompt-"));
      tmpPromptPath = path.join(tmpDir, "system-prompt.md");
      fs.writeFileSync(tmpPromptPath, systemPromptParts.join("\n\n"), "utf-8");
      args.push("--append-system-prompt", tmpPromptPath);
    }

    // Spawn child process
    const proc = spawn(invocation.command, args, {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Completion promise
    let resolveCompletion!: () => void;
    let rejectCompletion!: (err: Error) => void;
    const completionPromise = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const agent: ManagedAgent = {
      handle,
      agentName: config.agentName,
      model: config.model,
      task: config.task,
      status: "spawning",
      process: proc,
      stdin: proc.stdin!,
      messages: [],
      usage: emptyUsage(),
      startTime: Date.now(),
      workspaceId: config.workspaceId,
      workspace: config.workspace,
      completionPromise,
      _resolveCompletion: resolveCompletion,
      _rejectCompletion: rejectCompletion,
      _stdoutBuffer: "",
      _stderrBuffer: "",
    };

    this.agents.set(handle, agent);

    // Wire stdout → event parsing
    attachJsonlReader(
      proc.stdout!,
      (line) => this.handleEvent(agent, line, config.onUpdate),
      () => { /* stdout ended */ }
    );

    // Wire stderr
    attachJsonlReader(proc.stderr!, (line) => {
      agent._stderrBuffer += line + "\n";
    });

    // Process exit
    proc.on("close", (code) => {
      if (agent.status !== "completed" && agent.status !== "failed" && agent.status !== "aborted") {
        agent.status = code === 0 ? "completed" : "failed";
        agent.endTime = Date.now();
        agent.finalOutput = getFinalOutput(agent.messages);
      }
      agent._resolveCompletion();

      // Cleanup temp prompt file
      if (tmpPromptPath) {
        try { fs.unlinkSync(tmpPromptPath); fs.rmdirSync(path.dirname(tmpPromptPath)); } catch {}
      }
    });

    proc.on("error", (err) => {
      agent.status = "failed";
      agent.error = err.message;
      agent.endTime = Date.now();
      agent._resolveCompletion();
    });

    // Abort signal
    if (config.signal) {
      const onAbort = () => {
        if (agent.status === "running" || agent.status === "spawning" || agent.status === "idle") {
          this.interrupt(handle);
        }
      };
      if (config.signal.aborted) onAbort();
      else config.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Send the task as the initial prompt
    sendPrompt(agent, config.task);

    return handle;
  }

  /** Send a steering message to a running agent (delivered after current turn finishes tool calls). */
  steer(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (agent.status !== "running" && agent.status !== "spawning") return false;

    sendPrompt(agent, message, "steer");
    return true;
  }

  /** Send a follow-up message (delivered when agent finishes all work). */
  followUp(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "spawning") return false;

    // Fence an immediate wait before the asynchronous agent_start event arrives.
    const previousStatus = agent.status;
    const previousOutput = agent.finalOutput;
    const previousError = agent.error;
    if (previousStatus === "idle") {
      agent.status = "spawning";
      agent.finalOutput = undefined;
      agent.error = undefined;
    }
    try {
      sendPrompt(agent, message, "followUp", previousStatus === "idle");
    } catch (error) {
      agent.status = previousStatus;
      agent.finalOutput = previousOutput;
      agent.error = previousError;
      throw error;
    }
    return true;
  }

  /** Interrupt/abort a running agent. */
  interrupt(handle: string, reason?: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (agent.status === "completed" || agent.status === "failed" || agent.status === "aborted") return false;

    // Send abort command via RPC
    try {
      rpcSend(agent.stdin, { type: "abort" });
    } catch {}

    agent.status = "aborted";
    agent.endTime = Date.now();
    agent.error = reason || "Interrupted by parent";
    agent.finalOutput = getFinalOutput(agent.messages);

    // Force kill after 5s if still alive
    const killTimeout = setTimeout(() => {
      if (!agent.process.killed) {
        agent.process.kill("SIGKILL");
      }
    }, 5000);
    agent.process.once("close", () => clearTimeout(killTimeout));

    return true;
  }

  /** Wait for a prompt result, not exit of the reusable RPC process. */
  async wait(handle: string, timeoutMs?: number, signal?: AbortSignal): Promise<AgentStatusInfo | null> {
    return waitForPrompt(() => this.getStatus(handle), timeoutMs, signal);
  }

  /** Get current status of an agent. */
  getStatus(handle: string): AgentStatusInfo | null {
    const agent = this.agents.get(handle);
    if (!agent) return null;

    return {
      handle: agent.handle,
      agentName: agent.agentName,
      model: agent.model,
      status: agent.status,
      task: agent.task,
      elapsedMs: (agent.endTime || Date.now()) - agent.startTime,
      usage: { ...agent.usage },
      workspaceId: agent.workspaceId,
      finalOutput: agent.finalOutput,
      error: agent.error,
    };
  }

  /** Get the full messages from a completed agent. */
  getMessages(handle: string): Message[] | null {
    const agent = this.agents.get(handle);
    if (!agent) return null;
    return [...agent.messages];
  }

  /** Get the workspace for an agent. */
  getWorkspace(handle: string): Workspace | null {
    const agent = this.agents.get(handle);
    if (!agent) return null;
    return agent.workspace ?? null;
  }

  /** List all managed agents. */
  list(): AgentStatusInfo[] {
    return Array.from(this.agents.keys())
      .map((h) => this.getStatus(h)!)
      .filter(Boolean);
  }

  /** Cleanup all running agents. */
  async cleanup(): Promise<void> {
    for (const [handle, agent] of this.agents) {
      if (agent.status === "running" || agent.status === "spawning" || agent.status === "idle") {
        this.interrupt(handle, "Session cleanup");
      }
    }
    // Wait for all to finish
    await Promise.allSettled(
      Array.from(this.agents.values()).map((a) => a.completionPromise)
    );
  }

  /** Remove completed agents from the registry to free memory. */
  prune(): number {
    let pruned = 0;
    for (const [handle, agent] of this.agents) {
      if (agent.status === "completed" || agent.status === "failed" || agent.status === "aborted") {
        this.agents.delete(handle);
        pruned++;
      }
    }
    return pruned;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private handleEvent(
    agent: ManagedAgent,
    line: string,
    onUpdate?: (event: AgentEvent) => void,
  ): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    // Auto-respond to extension UI requests (cancel all dialogs)
    if (event.type === "extension_ui_request") {
      const response: Record<string, unknown> = {
        type: "extension_ui_response",
        id: event.id,
        cancelled: true,
      };
      try { rpcSend(agent.stdin, response); } catch {}
      return;
    }

    // Track agent lifecycle
    switch (event.type) {
      case "agent_start":
        agent.status = "running";
        break;

      case "agent_end":
        if (event.messages) {
          for (const msg of event.messages) {
            // Avoid duplicates
            if (!agent.messages.some((m) => m === msg)) {
              agent.messages.push(msg);
            }
          }
        }
        agent.finalOutput = getFinalOutput(agent.messages);
        break;

      case "agent_settled":
        // agent_end can precede retry, compaction and queued continuations.
        // Only the session-level settled event proves reusable prompt idleness.
        if (agent.status === "running" || agent.status === "spawning") {
          agent.status = "idle";
        }
        agent.finalOutput = getFinalOutput(agent.messages);
        {
          const last = agent.messages.findLast(message => message.role === "assistant");
          if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
            agent.error = last.errorMessage || `Agent prompt ${last.stopReason}`;
          }
        }
        break;

      case "response":
        observePromptResponse(agent, event);
        break;

      case "message_end":
        if (event.message?.role === "assistant") {
          agent.messages.push(event.message);
          agent.usage.turns++;
          const usage = event.message.usage;
          if (usage) {
            agent.usage.input += usage.input || 0;
            agent.usage.output += usage.output || 0;
            agent.usage.cacheRead += usage.cacheRead || 0;
            agent.usage.cacheWrite += usage.cacheWrite || 0;
            agent.usage.cost += usage.cost?.total || 0;
            agent.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!agent.model && event.message.model) {
            agent.model = event.message.model;
          }
        }
        if (event.message?.role === "toolResult") {
          agent.messages.push(event.message);
        }
        break;

      case "tool_execution_start":
      case "tool_execution_end":
        // Track for progress reporting
        break;
    }

    // Forward event to callback
    onUpdate?.({ type: event.type, handle: agent.handle, data: event });
  }
}
