import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

const OWNER_CHECK_MS = 30_000;
function identity(): { parent: number; group: number } {
  const output = execFileSync("ps", ["-o", "ppid=,pgid=", "-p", String(process.pid)], {
    encoding: "utf8", timeout: 2000, maxBuffer: 4096,
  }).trim().split(/\s+/).map(Number);
  if (output.length !== 2 || output.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error("ps returned invalid ownership identity");
  return { parent: output[0], group: output[1] };
}

/** Explicitly loaded in each owned child, including with automatic extensions disabled. */
export default function childOwner(pi: ExtensionAPI) {
  const owner = Number(process.env.PI_SUBAGENT_OWNER_PID);
  let initial: ReturnType<typeof identity>;
  try {
    initial = identity();
    if (!Number.isSafeInteger(owner) || owner <= 0 || initial.parent !== owner) throw new Error("Child ownership parent mismatch");
    if (initial.group !== process.pid) throw new Error("Child requires its own process group");
  } catch (error) {
    console.error(`Subagent ownership initialization failed: ${error instanceof Error ? error.message : String(error)}. No child prompt is authorized.`);
    throw error;
  }
  const group = initial.group;
  let groupVerified = true;
  let context: ExtensionContext | undefined;
  let latest: unknown;
  const reportGuard = (data: unknown) => {
    latest = data;
    const value = data as { version?: number; state?: string; reason?: string };
    context?.ui.setStatus("subagent-guard", JSON.stringify({ version: value.version, state: value.state, reason: value.reason }));
  };
  const stopGroup = () => {
    if (!groupVerified) {
      console.error("Subagent group termination withheld: current group identity could not be verified.");
      return;
    }
    try { process.kill(-group, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(`Subagent owned-group termination failed: ${error instanceof Error ? error.message : String(error)}. Inspect surviving owned processes.`);
        process.exitCode = 1;
      }
    }
  };
  // RPC EOF normally exits immediately. The OS check covers a stalled RPC loop.
  process.once("exit", stopGroup);
  const timer = setInterval(() => {
    try {
      const current = identity();
      groupVerified = current.group === group;
      if (!groupVerified) throw new Error("Child process group identity changed");
      if (current.parent !== owner) {
        console.error("Subagent owner exited; terminating verified owned group. Session retained.");
        stopGroup();
      }
    } catch (error) {
      groupVerified = false;
      const reason = `Ownership verification failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`Subagent ${reason}. Child work stopped; inspect owned descendants.`);
      reportGuard({ version: 1, state: "paused", reason });
      clearInterval(timer);
      context?.abort();
      process.exitCode = 1;
      // RPC shutdown alone waits for another command when stdin is idle.
      // Terminate this verified self process; the exit hook reports why group
      // termination is withheld when the OS identity check failed.
      setImmediate(() => process.exit(1));
    }
  }, OWNER_CHECK_MS);
  timer.unref();
  pi.on("session_shutdown", event => {
    if (event.reason === "quit" || event.reason === "reload") clearInterval(timer);
  });
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "mantice-spend-guard");
    if (entry?.type === "custom") reportGuard(entry.data);
    else if (latest) reportGuard(latest);
  });
  pi.events.on("mantice:spend-guard", reportGuard);
  pi.registerCommand("subagent-owner-ready", {
    description: "Verified child ownership capability",
    async handler(_args, ctx) { ctx.ui.notify(`Owner ${owner}; OS verification every ${OWNER_CHECK_MS / 1000}s`, "info"); },
  });
}
