/** Persistent RPC child management; prompt completion is not process exit. */
import { spawn } from "node:child_process";
import { VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
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
import { sendPrompt } from "./agent-rpc-prompts.ts";
import { observeAgentEvent } from "./agent-events.ts";
import { reportActivity } from "./activity.ts";
import { admitChild, LIFETIME_POLICY } from "./child-policy.ts";
import { acquire, release, childArgs, childSessionFile, ownChild, terminateChild, activeCount, childPaused } from "./child-lifecycle.ts";

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  private agents = new Map<string, ManagedAgent>();

  /** Spawn a new child agent. Returns the handle immediately; the agent runs in background. */
  spawn(config: AgentSpawnConfig): string {
    assertManagedRuntime(VERSION);
    if (config.signal?.aborted) throw new Error("Subagent spawn cancelled");
    if (!config.model || !["mantice", "fornace"].includes(config.model.split("/")[0])) {
      throw new Error("Guarded child execution requires an explicit mantice/fornace model route.");
    }
    const policy = admitChild();
    const handle = generateHandle(config.agentName);
    if (config.sessionFile) {
      const entries = fs.readFileSync(config.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (entries[0]?.type !== "session" || typeof entries[0]?.id !== "string") throw new Error("Invalid child session header");
    }
    const sessionFile = config.sessionFile ?? childSessionFile(config.cwd);
    const session = SessionManager.open(sessionFile);
    if (!session.getEntries().some(e => e.type === "custom" && e.customType === LIFETIME_POLICY)) {
      session.appendCustomEntry(LIFETIME_POLICY, policy);
    }

    // Build CLI args
    const invocation = getPiInvocation();
    const args = [...invocation.args, "--mode", "rpc", "--session", sessionFile, ...childArgs()];
    if (config.model) args.push("--model", config.model);
    if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
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
    acquire(handle);
    const proc = spawn(invocation.command, args, {
      cwd: config.cwd,
      detached: true,
      env: { ...process.env, PI_SUBAGENT_OWNER_PID: String(process.pid),
        PI_SUBAGENT_DEPTH: String(policy.depth), PI_SUBAGENT_MAX_DEPTH: String(policy.maxDepth),
        PI_SUBAGENT_LIFETIME_TOKENS: String(policy.tokenLimit) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    ownChild(proc, handle);

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
      thinkingLevel: config.thinkingLevel,
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
      guardVerified: false,
      sessionFile,
      startPrompt: () => {
        if (agent.status === "spawning") sendPrompt(agent, config.task);
      },
      _stdoutBuffer: "",
      _stderrBuffer: "",
    };

    this.agents.set(handle, agent);
    reportActivity(agent, { type: "spawn" });

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
      clearTimeout(agent.idleTimer);
      clearTimeout(agent.preflightTimer);
      const wasIdle = agent.status === "idle";
      if (agent.status !== "completed" && agent.status !== "failed" && agent.status !== "aborted") {
        agent.status = code === 0 || wasIdle ? "completed" : "failed";
        agent.endTime = Date.now();
        agent.finalOutput = getFinalOutput(agent.messages);
        if (agent.status === "failed") agent.error = `Child exited before settlement (code ${code}). ${agent._stderrBuffer}`;
      }
      agent._resolveCompletion();
      reportActivity(agent, { type: "process_close" });

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
      reportActivity(agent, { type: "process_error" });
    });

    // Abort signal
    if (config.signal) {
      const onAbort = () => {
        if (agent.status === "running" || agent.status === "spawning" || agent.status === "idle") {
          this.interrupt(handle);
        }
      };
      if (config.signal.aborted) onAbort();
      else {
        config.signal.addEventListener("abort", onAbort, { once: true });
        proc.once("close", () => config.signal!.removeEventListener("abort", onAbort));
      }
    }

    // Admission preflight never submits paid work to an unguarded child.
    rpcSend(agent.stdin, { id: "guard-preflight", type: "get_commands" });
    agent.preflightTimer = setTimeout(() => {
      agent.status = "failed";
      agent.error = "Child guard preflight did not complete";
      reportActivity(agent, { type: "preflight_timeout" });
      terminateChild(proc);
    }, 30_000);
    agent.preflightTimer.unref();

    return handle;
  }

  /** Send a steering message to a running agent (delivered after current turn finishes tool calls). */
  steer(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (!agent.guardVerified) throw new Error("Child guard preflight pending");
    if (agent.status === "idle") return this.followUp(handle, message);
    if (agent.status !== "running" && agent.status !== "spawning") return false;

    sendPrompt(agent, message, "steer");
    return true;
  }

  /** Send a follow-up message (delivered when agent finishes all work). */
  followUp(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (!agent.guardVerified) throw new Error("Child guard preflight pending");
    if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "spawning") return false;

    // Fence an immediate wait before the asynchronous agent_start event arrives.
    const previousStatus = agent.status;
    if (agent.guardState && agent.guardState !== "ready") throw new Error(`Child guard ${agent.guardState}`);
    if (previousStatus === "idle") acquire(handle);
    clearTimeout(agent.idleTimer);
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
      if (previousStatus === "idle") release(handle);
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

    // Remove queued prompts before abort: Pi abort alone continues queued work.
    try {
      rpcSend(agent.stdin, { type: "clear_queue" });
      rpcSend(agent.stdin, { type: "abort" });
    } catch (error) { console.error("Subagent abort RPC failed", error); }

    agent.status = "aborted";
    agent.endTime = Date.now();
    agent.error = reason || "Interrupted by parent";
    agent.finalOutput = getFinalOutput(agent.messages);
    reportActivity(agent, { type: "interrupt" });

    terminateChild(agent.process);

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
      sessionFile: agent.sessionFile,
      guardState: agent.guardState,
      activeChildren: activeCount(),
      handle: agent.handle,
      agentName: agent.agentName,
      model: agent.model,
      responseModel: agent.responseModel,
      thinkingLevel: agent.thinkingLevel,
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
      if (agent.process.exitCode === null && agent.process.signalCode === null) {
        if (!this.interrupt(handle, "Session cleanup")) terminateChild(agent.process);
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
      if ((agent.status === "completed" || agent.status === "failed" || agent.status === "aborted") &&
          (agent.process.exitCode !== null || agent.process.signalCode !== null)) {
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
      observeAgentEvent(agent, event);
    } catch (error) {
      agent.status = "failed";
      agent.error = `Child RPC observation failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[subagent] ${agent.handle}: ${agent.error}`);
      childPaused(`${agent.handle}: ${agent.error}`);
      terminateChild(agent.process);
      reportActivity(agent, { type: "process_error" });
      return;
    }
    reportActivity(agent, event);

    // Forward event to callback
    onUpdate?.({ type: event.type, handle: agent.handle, data: event });
  }
}
