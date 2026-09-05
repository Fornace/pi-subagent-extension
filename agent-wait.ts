import type { AgentStatusInfo } from "./agent-manager-support.ts";

/** Observe prompt completion without terminating a reusable RPC child. */
export function waitForPrompt(
  status: () => AgentStatusInfo | null,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<AgentStatusInfo | null> {
  return new Promise((resolve, reject) => {
    let poll: ReturnType<typeof setTimeout> | undefined;
    const deadline = timeoutMs && timeoutMs > 0 ? performance.now() + timeoutMs : undefined;
    const finish = (result: AgentStatusInfo | null, error?: Error) => {
      clearTimeout(poll);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(null, new Error("Wait aborted"));
    const check = () => {
      if (signal?.aborted) return abort();
      const current = status();
      if (!current || ["idle", "completed", "failed", "aborted"].includes(current.status)) {
        return finish(current);
      }
      if (deadline !== undefined && performance.now() >= deadline) {
        return finish(null, new Error("Wait timed out"));
      }
      // Independent waits own their timers; cancelling one never aborts the child.
      poll = setTimeout(check, deadline === undefined ? 50 : Math.min(50, Math.max(1, deadline - performance.now())));
    };
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}
