import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ManagedAgent } from "./agent-manager-support.ts";

type Observation = { type: string; toolName?: string; path?: string; text?: string; reason?: string };
type Activity = {
  version: 1; sessionId: string; handle: string; agentName: string; state: string; at: number;
  task: string; model?: string; sessionFile: string; usage: ManagedAgent["usage"]; event: Observation;
};
const observed = new Map<string, Activity>();
const sentAt = new Map<string, number>();
let sessionId = "";
let publish: ((record: Activity) => void) | undefined;
const clean = (text: string, limit: number) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);

/** A display-only channel. It never queues a model prompt or polls a child. */
export function reportActivity(agent: ManagedAgent, event: any): void {
  const type = String(event.type);
  if (!["spawn", "agent_start", "agent_settled", "message_update", "message_end", "tool_execution_start",
    "tool_execution_end", "process_close", "process_error", "interrupt", "preflight_timeout", "subagent_guard", "extension_ui_request"].includes(type)) return;
  const prior = observed.get(agent.handle);
  let observation: Observation = { type };
  if (type === "tool_execution_start" || type === "tool_execution_end") {
    observation.toolName = clean(String(event.toolName), 48);
    if (typeof event.args?.path === "string") observation.path = clean(event.args.path, 512);
  }
  const message = event.message;
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    const text = message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: { text: string }) => part.text).join(" ");
    if (text.trim()) observation.text = clean(text, 240);
  }
  if (agent.error) observation.reason = clean(agent.error, 240);
  if (!observation.text && prior?.event.text) observation.text = prior.event.text;
  if (!["agent_start", "spawn"].includes(type) && !observation.toolName && prior?.event.toolName) {
    observation.toolName = prior.event.toolName;
    observation.path = prior.event.path;
  }
  // Never expose shell commands, tool results, thinking text or system prompts.
  if (type === "extension_ui_request" && agent.guardState !== "paused") return;
  const record: Activity = {
    version: 1, sessionId, handle: agent.handle, agentName: agent.agentName,
    state: agent.guardState === "paused" ? "paused" : agent.status,
    at: Date.now(), task: clean(agent.task, 240), model: agent.responseModel ?? agent.model,
    sessionFile: agent.sessionFile, usage: { ...agent.usage }, event: observation,
  };
  observed.set(agent.handle, record);
  if (type === "message_update" && prior?.state === record.state && record.at - (sentAt.get(agent.handle) ?? 0) < 250) return;
  sentAt.set(agent.handle, record.at);
  publish?.(record);
}

export function registerActivity(pi: ExtensionAPI): void {
  publish = record => pi.events.emit("subagent:activity", record);
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    observed.clear(); sentAt.clear();
  });
  pi.events.on("subagent:activity-request", (request: unknown) => {
    if ((request as { sessionId?: string })?.sessionId !== sessionId) return;
    for (const record of observed.values()) publish?.(record);
  });
  pi.on("session_shutdown", () => { publish = undefined; observed.clear(); sentAt.clear(); sessionId = ""; });
}
