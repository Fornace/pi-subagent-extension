import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

/** Explicitly loaded in each owned child, including when automatic extensions are disabled. */
export default function childOwner(pi: ExtensionAPI) {
  const owner = Number(process.env.PI_SUBAGENT_OWNER_PID);
  if (!Number.isInteger(owner) || owner !== process.ppid) throw new Error("Child ownership identity mismatch");
  const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
  if (group !== process.pid) throw new Error("Child requires its own process group");
  // Node exposes ppid as a startup snapshot. Query the OS for reparenting.
  process.once("exit", () => process.kill(-group, "SIGKILL"));
  const timer = setInterval(() => {
    const currentParent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
    if (currentParent !== owner) {
      console.error("Subagent owner exited; terminating owned process group. Session retained.");
      process.kill(-group, "SIGKILL");
    }
  }, 1000);
  timer.unref();
  pi.on("session_shutdown", event => {
    if (event.reason === "quit" || event.reason === "reload") clearInterval(timer);
  });
  pi.events.on("mantice:spend-guard", (data: unknown) => {
    const value = data as { state?: string; reason?: string };
    process.stdout.write(JSON.stringify({ type: "subagent_guard", state: value.state, reason: value.reason }) + "\n");
  });
}
