import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagedAgent } from "./agent-manager-support.ts";

export const USAGE_RECEIPT_ENTRY = "subagent-usage-receipt";
export const YIELD_ENTRY = "subagent-worker-yield";
type AssistantEvent = {
  type?: string;
  message?: {
    role?: string; content?: unknown; timestamp?: number; model?: string; stopReason?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
};
let context: ExtensionContext | undefined;
let append: ((type: string, record: object) => void) | undefined;
let wakeParent: ((content: string, details: object) => void) | undefined;
const seen = new Set<string>();
const yielded = new Set<string>();

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
  return goal?.status === "active" ? goal.id : undefined;
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
  append(USAGE_RECEIPT_ENTRY, record);
  seen.add(receiptId);
}

export function reportYield(agent: ManagedAgent, event: { outcome?: string; reason?: string; at?: number }): void {
  if (event.outcome !== "budget_yield" || !context || !append || !wakeParent || !agent.parentGoalId) return;
  const yieldId = createHash("sha256").update(JSON.stringify([
    agent.sessionFile, agent.parentGoalId, event.at, event.reason,
  ])).digest("hex");
  if (yielded.has(yieldId)) return;
  const output = agent.finalOutput?.trim().slice(0, 1000) || "No text output yet.";
  const record = { version: 1, yieldId, sessionId: context.sessionManager.getSessionId(),
    goalId: agent.parentGoalId, handle: agent.handle, childSessionFile: agent.sessionFile,
    at: Number.isSafeInteger(event.at) ? event.at : Date.now(), reason: event.reason ?? "Worker token tranche reached",
    output };
  append(YIELD_ENTRY, record);
  yielded.add(yieldId);
  if (agent.wakeOnYield && activeGoalId() === agent.parentGoalId) {
    wakeParent(`Worker ${agent.handle} yielded its token tranche. Continue the goal from its partial result, or launch a fresh bounded assignment within the remaining owner budget.\n\nSaved session: ${agent.sessionFile}\n\n${output}`,
    { kind: "worker_budget_yield", goalId: agent.parentGoalId, yieldId, handle: agent.handle });
  }
}

export function registerUsageReceipts(pi: ExtensionAPI): void {
  const restore = (ctx: ExtensionContext) => {
    context = ctx; seen.clear(); yielded.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === YIELD_ENTRY) {
        const id = (entry.data as { yieldId?: string })?.yieldId;
        if (typeof id === "string") yielded.add(id);
        continue;
      }
      if (entry.customType !== USAGE_RECEIPT_ENTRY) continue;
      const id = (entry.data as { receiptId?: string })?.receiptId;
      if (typeof id === "string") seen.add(id);
    }
  };
  append = (type, record) => { pi.appendEntry(type, record); if (type === USAGE_RECEIPT_ENTRY) pi.events.emit("subagent:usage", record); };
  wakeParent = (content, details) => pi.sendMessage({ customType: YIELD_ENTRY, content, display: true, details },
    { triggerTurn: true, deliverAs: "followUp" });
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    context = undefined; append = undefined; wakeParent = undefined; seen.clear(); yielded.clear();
  });
}
