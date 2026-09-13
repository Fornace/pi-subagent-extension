import { type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { release, setAdmissionBlock } from "./child-admission.ts";
export { acquire, release, activeCount, setAdmissionBlock, MAX_ACTIVE_CHILDREN } from "./child-admission.ts";

export const IDLE_REAP_MS = 60_000;
const children = new Set<ChildProcess>();
const terminating = new WeakSet<ChildProcess>();
let reportPause: (reason: string) => void = () => {};
export function onChildPause(report: (reason: string) => void): void { reportPause = report; }
export function childPaused(reason: string): void { setAdmissionBlock(reason); reportPause(reason); }
export function childSessionFile(cwd: string): string {
  const dir = join(homedir(), ".pi", "agent", "subagent-sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const session = SessionManager.create(cwd, dir);
  const file = session.getSessionFile()!;
  // Pi otherwise defers disk creation until its first assistant message.
  // Pre-create the official header so pre-transport guard pauses persist too.
  writeFileSync(file, JSON.stringify(session.getHeader()) + "\n", { mode: 0o600, flag: "wx" });
  return file;
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
