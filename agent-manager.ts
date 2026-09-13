/** Durable RPC children with shared FIFO admission and reusable prompt rounds. */
import { VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { Workspace } from "./workspace.ts";
import { assertManagedRuntime } from "./agent-runtime.ts";
import { generateHandle, getFinalOutput, emptyUsage, rpcSend,
  type AgentSpawnConfig, type ManagedAgent, type AgentEvent, type AgentStatusInfo } from "./agent-manager-support.ts";
export type { AgentSpawnConfig, AgentState, UsageStats, ManagedAgent, AgentEvent, AgentStatusInfo } from "./agent-manager-support.ts";
import { waitForPrompt } from "./agent-wait.ts";
import { sendPrompt } from "./agent-rpc-prompts.ts";
import { observeAgentEvent } from "./agent-events.ts";
import { reportActivity } from "./activity.ts";
import { admitChild, LIFETIME_POLICY } from "./child-policy.ts";
import { childSessionFile, terminateChild, childPaused } from "./child-lifecycle.ts";
import { queueChild, activeCount, queuedCount, admissionReason } from "./child-admission.ts";
import { launchAgent } from "./managed-launch.ts";

export class AgentManager {
  private agents = new Map<string, ManagedAgent>();

  /** Return a handle immediately. Queued work starts automatically when capacity opens. */
  spawn(config: AgentSpawnConfig): string {
    assertManagedRuntime(VERSION);
    if (config.signal?.aborted) throw new Error("Subagent spawn cancelled");
    if (!config.model || !["mantice", "fornace"].includes(config.model.split("/")[0])) {
      throw new Error("Guarded child execution requires an explicit mantice/fornace model route.");
    }
    const policy = admitChild();
    const handle = generateHandle(config.agentName);
    if (config.sessionFile) {
      const entries = readFileSync(config.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (entries[0]?.type !== "session" || typeof entries[0]?.id !== "string") throw new Error("Invalid child session header");
    }
    const sessionFile = config.sessionFile ?? childSessionFile(config.cwd);
    const session = SessionManager.open(sessionFile);
    if (!session.getEntries().some(e => e.type === "custom" && e.customType === LIFETIME_POLICY)) {
      session.appendCustomEntry(LIFETIME_POLICY, policy);
    }
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completionPromise = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const agent: ManagedAgent = {
      handle, agentName: config.agentName, model: config.model, thinkingLevel: config.thinkingLevel,
      task: config.task, queuedPrompt: config.task, status: "queued", messages: [], usage: emptyUsage(),
      startTime: Date.now(), workspaceId: config.workspaceId, workspace: config.workspace,
      completionPromise, _resolveCompletion: resolveCompletion, _rejectCompletion: rejectCompletion,
      guardVerified: false, sessionFile, startPrompt: () => { throw new Error("Child launch pending"); },
      _stdoutBuffer: "", _stderrBuffer: "",
    };
    this.agents.set(handle, agent);
    this.schedule(agent, () => launchAgent(agent, config, policy,
      (line, onUpdate) => this.handleEvent(agent, line, onUpdate)));
    if (config.signal) {
      const onAbort = () => this.interrupt(handle, "Spawn cancelled");
      config.signal.addEventListener("abort", onAbort, { once: true });
      completionPromise.then(() => config.signal!.removeEventListener("abort", onAbort));
      if (config.signal.aborted) onAbort();
    }
    return handle;
  }

  private schedule(agent: ManagedAgent, start: () => void): void {
    agent.status = "queued";
    agent.cancelAdmission = queueChild(agent.handle, () => {
      agent.cancelAdmission = undefined;
      start();
    }, error => {
      agent.status = "failed";
      agent.error = `Child dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
      agent.endTime = Date.now();
      console.error(`[subagent] ${agent.handle}: ${agent.error}`);
      if (agent.process) terminateChild(agent.process);
      else agent._resolveCompletion();
      reportActivity(agent, { type: "process_error" });
    });
    reportActivity(agent, { type: "queued" });
  }

  steer(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (agent.status === "queued") {
      if (agent.queuedPrompt === undefined) throw new Error("Queued child prompt is missing");
      agent.queuedPrompt += `\n\n${message}`;
      return true;
    }
    if (!agent.guardVerified) throw new Error("Child guard preflight pending");
    if (agent.status === "idle") return this.followUp(handle, message);
    if (agent.status !== "running" && agent.status !== "spawning") return false;
    sendPrompt(agent, message, "steer");
    return true;
  }

  followUp(handle: string, message: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent) return false;
    if (agent.status === "queued") return this.steer(handle, message);
    if (!agent.guardVerified) throw new Error("Child guard preflight pending");
    if (!["running", "idle", "spawning"].includes(agent.status)) return false;
    if (agent.guardState && agent.guardState !== "ready") throw new Error(`Child guard ${agent.guardState}`);
    if (agent.status !== "idle") {
      sendPrompt(agent, message, "followUp");
      return true;
    }
    clearTimeout(agent.idleTimer);
    agent.queuedPrompt = message;
    agent.finalOutput = undefined;
    agent.error = undefined;
    this.schedule(agent, () => {
      agent.status = "spawning";
      if (agent.queuedPrompt === undefined) throw new Error("Queued follow-up is missing");
      sendPrompt(agent, agent.queuedPrompt, "followUp", true);
      agent.queuedPrompt = undefined;
    });
    return true;
  }

  interrupt(handle: string, reason?: string): boolean {
    const agent = this.agents.get(handle);
    if (!agent || ["completed", "failed", "aborted"].includes(agent.status)) return false;
    agent.cancelAdmission?.();
    agent.cancelAdmission = undefined;
    if (agent.stdin) {
      try {
        rpcSend(agent.stdin, { type: "clear_queue" });
        rpcSend(agent.stdin, { type: "abort" });
      } catch (error) { console.error("Subagent abort RPC failed", error); }
    }
    agent.status = "aborted";
    agent.endTime = Date.now();
    agent.error = reason || "Interrupted by parent";
    agent.finalOutput = getFinalOutput(agent.messages);
    reportActivity(agent, { type: "interrupt" });
    if (agent.process) terminateChild(agent.process);
    else agent._resolveCompletion();
    return true;
  }

  async wait(handle: string, timeoutMs?: number, signal?: AbortSignal): Promise<AgentStatusInfo | null> {
    return waitForPrompt(() => this.getStatus(handle), timeoutMs, signal);
  }

  getStatus(handle: string): AgentStatusInfo | null {
    const agent = this.agents.get(handle);
    if (!agent) return null;
    return {
      sessionFile: agent.sessionFile, guardState: agent.guardState,
      activeChildren: activeCount(), queuedChildren: queuedCount(),
      queueReason: agent.status === "queued" ? admissionReason() ?? "Waiting for dispatch capacity" : undefined,
      handle: agent.handle, agentName: agent.agentName, model: agent.model,
      responseModel: agent.responseModel, thinkingLevel: agent.thinkingLevel, status: agent.status,
      task: agent.task, elapsedMs: (agent.endTime || Date.now()) - agent.startTime,
      usage: { ...agent.usage }, workspaceId: agent.workspaceId,
      finalOutput: agent.finalOutput, error: agent.error,
    };
  }

  getMessages(handle: string): Message[] | null {
    const agent = this.agents.get(handle);
    return agent ? [...agent.messages] : null;
  }

  getWorkspace(handle: string): Workspace | null { return this.agents.get(handle)?.workspace ?? null; }

  list(): AgentStatusInfo[] { return [...this.agents.keys()].map(handle => this.getStatus(handle)!); }

  async cleanup(): Promise<void> {
    for (const [handle, agent] of this.agents) {
      if (!agent.process) this.interrupt(handle, "Session cleanup");
      else if (agent.process.exitCode === null && agent.process.signalCode === null) {
        if (!this.interrupt(handle, "Session cleanup")) terminateChild(agent.process);
      }
    }
    await Promise.all([...this.agents.values()].map(agent => agent.completionPromise));
  }

  prune(): number {
    let pruned = 0;
    for (const [handle, agent] of this.agents) {
      if (["completed", "failed", "aborted"].includes(agent.status) &&
          (!agent.process || agent.process.exitCode !== null || agent.process.signalCode !== null)) {
        this.agents.delete(handle);
        pruned++;
      }
    }
    return pruned;
  }

  private handleEvent(agent: ManagedAgent, line: string, onUpdate?: (event: AgentEvent) => void): void {
    let event: any;
    try {
      event = JSON.parse(line);
      observeAgentEvent(agent, event);
    } catch (error) {
      agent.status = "failed";
      agent.error = `Child RPC observation failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[subagent] ${agent.handle}: ${agent.error}`);
      childPaused(`${agent.handle}: ${agent.error}`);
      if (agent.process) terminateChild(agent.process);
      reportActivity(agent, { type: "process_error" });
      return;
    }
    reportActivity(agent, event);
    onUpdate?.({ type: event.type, handle: agent.handle, data: event });
  }
}
