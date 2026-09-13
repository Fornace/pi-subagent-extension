import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails } from "./subagent-common.ts";
import type { AgentStatusInfo } from "./agent-manager-support.ts";
import { isFailedResult } from "./subagent-common.ts";

/** Preserve partial batch results while using Pi's supported error-result hook. */
export function registerToolOutcomes(pi: ExtensionAPI): void {
  pi.on("tool_result", event => {
    if (event.isError) return;
    if (event.toolName === "subagent") {
      const details = event.details as SubagentDetails | undefined;
      if (details?.results.some(isFailedResult)) return { isError: true };
    }
    if (event.toolName === "agent_wait") {
      const details = event.details as { status?: AgentStatusInfo } | undefined;
      const status = details?.status;
      if (status && (status.error || status.status === "failed" || status.status === "aborted")) {
        return { isError: true };
      }
    }
  });
}
