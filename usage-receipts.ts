import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagedAgent } from "./agent-manager-support.ts";

export const USAGE_RECEIPT_ENTRY = "subagent-usage-receipt";
type AssistantEvent = {
  type?: string;
  message?: {
    role?: string; content?: unknown; timestamp?: number; model?: string; stopReason?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
};
let context: ExtensionContext | undefined;
let append: ((record: object) => void) | undefined;
const seen = new Set<string>();

export function activeGoalId(): string | undefined {
  let goal: { id: string; status: string } | undefined;
  for (const entry of context?.sessionManager.getBranch() ?? []) {
    if (entry.type !== "custom" || entry.customType !== "pi-codex-goal") continue;
    const data = entry.data as { kind?: string; goal?: { goalId?: string; status?: string }; status?: string };
    if (data.kind === "clear") goal = undefined;
    if (data.kind === "set" && typeof data.goal?.goalId === "string") {
      goal = { id: data.goal.goalId, status: data.goal.status ?? "" };
    }
    if (data.kind === "usage" && goal && typeof data.status === "string") goal.status = data.status;
  }
  return goal && ["active", "budgetLimited"].includes(goal.status) ? goal.id : undefined;
}

/** Persist and emit one immutable usage fact per observed child assistant message. */
export function reportUsage(agent: ManagedAgent, event: AssistantEvent): void {
  const message = event.message;
  if (event.type !== "message_end" || message?.role !== "assistant" || !message.usage || !context || !append) return;
  const channels = [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite];
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp! <= 0 ||
      channels.some(value => !Number.isSafeInteger(value) || value! < 0)) {
    console.error(`[subagent] ${agent.handle}: assistant usage receipt rejected because timestamp or usage is invalid`);
    return;
  }
  const usage = { input: channels[0]!, output: channels[1]!, cacheRead: channels[2]!, cacheWrite: channels[3]! };
  const identity = JSON.stringify([agent.sessionFile, message.timestamp,
    message.model ?? agent.responseModel ?? agent.model, message.stopReason, usage, message.content]);
  const receiptId = createHash("sha256").update(identity).digest("hex");
  if (seen.has(receiptId)) return;
  const id = agent.parentGoalId;
  if (!id) return;
  const record = { version: 1, sessionId: context.sessionManager.getSessionId(), goalId: id,
    receiptId, handle: agent.handle, childSessionFile: agent.sessionFile, at: message.timestamp, usage };
  append(record);
  seen.add(receiptId);
}

export function registerUsageReceipts(pi: ExtensionAPI): void {
  const restore = (ctx: ExtensionContext) => {
    context = ctx; seen.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== USAGE_RECEIPT_ENTRY) continue;
      const id = (entry.data as { receiptId?: string })?.receiptId;
      if (typeof id === "string") seen.add(id);
    }
  };
  append = record => { pi.appendEntry(USAGE_RECEIPT_ENTRY, record); pi.events.emit("subagent:usage", record); };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { context = undefined; append = undefined; seen.clear(); });
}
