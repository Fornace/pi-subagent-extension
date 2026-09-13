import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPiInvocation, getFinalOutput, rpcSend, attachJsonlReader,
  type ManagedAgent, type AgentSpawnConfig, type AgentEvent } from "./agent-manager-support.ts";
import { childArgs, ownChild, terminateChild } from "./child-lifecycle.ts";
import { admitChild } from "./child-policy.ts";
import { reportActivity } from "./activity.ts";
import { sendPrompt } from "./agent-rpc-prompts.ts";

/** Called only after the shared scheduler has reserved this handle's permit. */
export function launchAgent(
  agent: ManagedAgent, config: AgentSpawnConfig, policy: ReturnType<typeof admitChild>,
  observe: (line: string, onUpdate?: (event: AgentEvent) => void) => void,
): void {
  const invocation = getPiInvocation();
  const args = [...invocation.args, "--mode", "rpc", "--session", agent.sessionFile, ...childArgs()];
  args.push("--model", config.model!);
  if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
  if (config.tools?.length) args.push("--tools", config.tools.join(","));
  const parts = config.systemPrompt ? [config.systemPrompt] : [];
  if (config.workspace) {
    parts.push(`\n## Shared Workspace\nYour workspace directory is: ${config.workspace.path}\n` +
      `Write findings to: ${config.workspace.path}/findings.md\n` +
      `Write structured data to: ${config.workspace.path}/state.json\n` +
      "Other agents may read these files to coordinate with you.\nUse read/write/bash tools to access workspace files.");
  }
  let promptDir: string | undefined;
  const cleanupPrompt = () => {
    if (!promptDir) return;
    try { rmSync(promptDir, { recursive: true }); }
    catch (error) { console.error(`[subagent] Prompt cleanup failed: ${promptDir}`, error); }
    promptDir = undefined;
  };
  try {
    if (parts.length) {
      promptDir = mkdtempSync(join(tmpdir(), "pi-agent-prompt-"));
      const file = join(promptDir, "system-prompt.md");
      writeFileSync(file, parts.join("\n\n"), { mode: 0o600 });
      args.push("--append-system-prompt", file);
    }
    const proc = spawn(invocation.command, args, {
      cwd: config.cwd, detached: true,
      env: { ...process.env, PI_SUBAGENT_OWNER_PID: String(process.pid),
        PI_SUBAGENT_DEPTH: String(policy.depth), PI_SUBAGENT_MAX_DEPTH: String(policy.maxDepth),
        PI_SUBAGENT_LIFETIME_TOKENS: String(policy.tokenLimit) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    agent.process = proc;
    agent.stdin = proc.stdin!;
    agent.status = "spawning";
    ownChild(proc, agent.handle);
    agent.startPrompt = () => {
      if (agent.status !== "spawning") return;
      if (agent.queuedPrompt === undefined) throw new Error("Child initial prompt is missing");
      sendPrompt(agent, agent.queuedPrompt);
      agent.queuedPrompt = undefined;
    };
    reportActivity(agent, { type: "spawn" });
    attachJsonlReader(proc.stdout!, line => observe(line, config.onUpdate));
    attachJsonlReader(proc.stderr!, line => { agent._stderrBuffer += line + "\n"; });
    proc.on("close", code => {
      agent.cancelAdmission?.();
      agent.cancelAdmission = undefined;
      clearTimeout(agent.idleTimer);
      clearTimeout(agent.preflightTimer);
      const wasIdle = agent.status === "idle";
      if (!["completed", "yielded", "failed", "aborted"].includes(agent.status)) {
        agent.status = wasIdle ? "completed" : "failed";
        agent.endTime = Date.now();
        agent.finalOutput = getFinalOutput(agent.messages);
        if (agent.status === "failed") agent.error = `Child exited before settlement (code ${code}). ${agent._stderrBuffer}`;
      }
      agent._resolveCompletion();
      reportActivity(agent, { type: "process_close" });
      cleanupPrompt();
    });
    proc.on("error", error => {
      agent.status = "failed";
      agent.error = error.message;
      agent.endTime = Date.now();
      agent._resolveCompletion();
      reportActivity(agent, { type: "process_error" });
    });
    rpcSend(agent.stdin, { id: "guard-preflight", type: "get_commands" });
    agent.preflightTimer = setTimeout(() => {
      agent.status = "failed";
      agent.error = "Child guard preflight did not complete";
      reportActivity(agent, { type: "preflight_timeout" });
      terminateChild(proc);
    }, 30_000);
    agent.preflightTimer.unref();
  } catch (error) {
    cleanupPrompt();
    if (agent.process) terminateChild(agent.process);
    throw error;
  }
}
