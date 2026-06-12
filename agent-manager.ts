/**
 * AgentManager — spawns and manages child pi agents via RPC protocol
 *
 * Each child runs as `pi --mode rpc --no-session` with stdin/stdout JSON lines.
 * Supports: steer, interrupt, wait, status, and shared workspaces.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { Workspace } from "./workspace.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentSpawnConfig {
  agentName: string;
  model?: string;
  systemPrompt?: string;
  task: string;
  cwd: string;
  workspaceId?: string;
  workspace?: Workspace;
  signal?: AbortSignal;
  tools?: string[];
  onUpdate?: (event: AgentEvent) => void;
}

export type AgentState = "spawning" | "running" | "idle" | "completed" | "failed" | "aborted";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  contextTokens: number;
}

export interface ManagedAgent {
  handle: string;
  agentName: string;
  model?: string;
  task: string;
  status: AgentState;
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  messages: Message[];
  usage: UsageStats;
  startTime: number;
  endTime?: number;
  finalOutput?: string;
  error?: string;
  workspaceId?: string;
  workspace?: Workspace;
  completionPromise: Promise<void>;
  _resolveCompletion: () => void;
  _rejectCompletion: (err: Error) => void;
  _stdoutBuffer: string;
  _stderrBuffer: string;
}

export interface AgentEvent {
  type: string;
  handle: string;
  data?: any;
}

export interface AgentStatusInfo {
  handle: string;
  agentName: string;
  model?: string;
  status: AgentState;
  task: string;
  elapsedMs: number;
  usage: UsageStats;
  workspaceId?: string;
  finalOutput?: string;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let handleCounter = 0;

function generateHandle(agentName: string): string {
  return `${agentName}-${++handleCounter}`;
}

function getPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: [] };
  }
  return { command: "pi", args: [] };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
}

function rpcSend(stdin: NodeJS.WritableStream, cmd: Record<string, unknown>): void {
  stdin.write(JSON.stringify(cmd) + "\n");
}

/** Attach a JSONL reader to a stream. Splits on \n only (protocol-compliant). */
function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onEnd?: () => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line) onLine(line);
    }
    onEnd?.();
  });
}

// ─── AgentManager ────────────────────────────────────────────────────────────

export class AgentManager {
  private agents = new Map<string, ManagedAgent>();

  /** Spawn a new child agent. Returns the handle immediately; the agent runs in background. */
  spawn(config: AgentSpawnConfig): string {
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
    rpcSend(agent.stdin, { type: "prompt", message: config.task });

    return handle;
  }

  /** Send a steering message to a running agent (delivered after current turn finishes tool calls). */
  steer(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (agent.status !== "running" && agent.status !== "spawning") return false;

    rpcSend(agent.stdin, {
      type: "prompt",
      message,
      streamingBehavior: "steer",
    });
    return true;
  }

  /** Send a follow-up message (delivered when agent finishes all work). */
  followUp(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (agent.status !== "running" && agent.status !== "idle" && agent.status !== "spawning") return false;

    rpcSend(agent.stdin, {
      type: "prompt",
      message,
      streamingBehavior: "followUp",
    });
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

  /** Wait for an agent to complete. Returns status info. */
  async wait(handle: string, timeoutMs?: number): Promise<AgentStatusInfo | null> {
    const agent = this.agents.get(handle);
    if (!agent) return null;

    // Already done?
    if (agent.status === "completed" || agent.status === "failed" || agent.status === "aborted") {
      return this.getStatus(handle);
    }

    // Wait with optional timeout
    if (timeoutMs && timeoutMs > 0) {
      await Promise.race([
        agent.completionPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Wait timed out")), timeoutMs)
        ),
      ]);
    } else {
      await agent.completionPromise;
    }

    return this.getStatus(handle);
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
        if (agent.status === "running") {
          agent.status = "idle"; // idle = finished prompt, waiting for next
        }
        agent.finalOutput = getFinalOutput(agent.messages);
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
