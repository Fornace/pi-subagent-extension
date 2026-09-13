import { type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Managed and batch paths share admission. Idle RPC processes do not hold permits.
export const MAX_ACTIVE_CHILDREN = 4;
export const IDLE_REAP_MS = 60_000;
const active = new Set<string>();
const children = new Set<ChildProcess>();
const terminating = new WeakSet<ChildProcess>();
let blocked: string | undefined;
let reportPause: (reason: string) => void = () => {};
export function setAdmissionBlock(reason?: string): void { blocked = reason; }
export function onChildPause(report: (reason: string) => void): void { reportPause = report; }
export function childPaused(reason: string): void { blocked = reason; reportPause(reason); }
export function acquire(key: string): void {
  if (blocked) throw new Error(`Child admission paused: ${blocked}`);
  if (active.has(key)) return;
  if (active.size >= MAX_ACTIVE_CHILDREN) throw new Error(`Active child limit ${MAX_ACTIVE_CHILDREN} reached. Wait for a settled child.`);
  active.add(key);
}
export function release(key: string): void { active.delete(key); }
export function activeCount(): number { return active.size; }
export function childSessionFile(): string {
  const dir = join(homedir(), ".pi", "agent", "subagent-sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${randomUUID()}.jsonl`);
}
export function childArgs(): string[] {
  if (process.platform === "win32") throw new Error("Owned child process groups require POSIX in this release.");
  const args = ["-e", fileURLToPath(new URL("./child-owner.ts", import.meta.url))];
  if (process.env.PI_SUBAGENT_GUARD_EXTENSION) args.push("-e", process.env.PI_SUBAGENT_GUARD_EXTENSION);
  return args;
}
export function stopChild(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  // Only process groups created by this module's detached direct children.
  if (!children.has(proc) || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  try { process.kill(-proc.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
export function ownChild(proc: ChildProcess, key: string): void {
  children.add(proc);
  proc.once("close", () => { children.delete(proc); release(key); });
  proc.once("error", () => { children.delete(proc); release(key); });
}
export function terminateChild(proc: ChildProcess): void {
  if (terminating.has(proc)) return;
  terminating.add(proc);
  stopChild(proc);
  const timer = setTimeout(() => stopChild(proc, "SIGKILL"), 5000);
  timer.unref();
  proc.once("close", () => clearTimeout(timer));
}
process.once("exit", () => {
  for (const proc of children) stopChild(proc, "SIGKILL");
});
