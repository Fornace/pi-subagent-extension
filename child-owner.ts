import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  let context: ExtensionContext | undefined;
  let latest: unknown;
  const reportGuard = (data: unknown) => {
    latest = data;
    // RPC reserves stdout. Use its documented fire-and-forget UI channel.
    const value = data as { version?: number; state?: string; reason?: string };
    context?.ui.setStatus("subagent-guard", JSON.stringify({ version: value.version, state: value.state, reason: value.reason }));
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "mantice-spend-guard");
    if (entry?.type === "custom") reportGuard(entry.data);
    else if (latest) reportGuard(latest);
  });
  pi.events.on("mantice:spend-guard", reportGuard);
}
