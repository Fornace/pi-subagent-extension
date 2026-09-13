import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDispatchPolicy } from "./child-policy.ts";
import { onChildPause, setAdmissionBlock } from "./child-lifecycle.ts";
const ENTRY = "subagent-admission-guard";
export function registerOwnerGuard(pi: ExtensionAPI) {
  registerDispatchPolicy(pi);
  let ctx: ExtensionContext | undefined;
  let childPause: string | undefined;
  let mechanical: { state: string; reason: string } | undefined;
  function refresh() { setAdmissionBlock(childPause ?? (mechanical && mechanical.state !== "ready" ? mechanical.reason : undefined)); }
  const restore = (context: ExtensionContext) => {
    ctx = context; childPause = undefined; mechanical = undefined;
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "mantice-spend-guard") mechanical = entry.data as typeof mechanical;
      if (entry.customType === ENTRY) childPause = (entry.data as { reason?: string }).reason;
    }
    refresh();
  };
  pi.on("session_start", (_e, context) => restore(context));
  pi.on("session_tree", (_e, context) => restore(context));
  pi.events.on("mantice:spend-guard", (data: unknown) => {
    const event = data as { state: string; reason: string; sessionId: string };
    if (event.sessionId !== ctx?.sessionManager.getSessionId()) return;
    mechanical = event; refresh();
  });
  onChildPause(reason => {
    childPause = reason; refresh();
    pi.appendEntry(ENTRY, { version: 1, reason, at: Date.now() });
    pi.events.emit("subagent:guard-paused", { reason });
    ctx?.ui.notify(reason, "warning");
  });
  pi.registerCommand("subagent-guard", {
    description: "Inspect child admission or explicitly reset after child repair",
    async handler(args, context) {
      if (args.trim() === "reset") {
        if (!context.isIdle() || (mechanical && mechanical.state !== "ready")) {
          context.ui.notify("Wait for owner idle and a ready Mantice guard.", "warning"); return;
        }
        childPause = undefined;
        pi.appendEntry(ENTRY, { version: 1, at: Date.now() });
        refresh();
      }
      context.ui.notify(childPause ?? (mechanical?.state !== "ready" && mechanical ? mechanical.reason : "Child admission ready"));
    },
  });
}
