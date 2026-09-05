import { rpcSend, type ManagedAgent } from "./agent-manager-support.ts";

interface PromptRound {
  pending: Set<string>;
  accepted: boolean;
}
const rounds = new WeakMap<ManagedAgent, PromptRound>();
let sequence = 0;

export function sendPrompt(
  agent: ManagedAgent,
  message: string,
  streamingBehavior?: "steer" | "followUp",
  newRound = false,
): void {
  let round = rounds.get(agent);
  if (!round || newRound) {
    round = { pending: new Set(), accepted: false };
    rounds.set(agent, round);
  }
  if (round.pending.size >= 256) throw new Error("Too many unacknowledged RPC prompts");
  const id = `managed-prompt-${++sequence}`;
  round.pending.add(id);
  try {
    rpcSend(agent.stdin, { id, type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  } catch (error) {
    round.pending.delete(id);
    throw error;
  }
}

export function observePromptResponse(agent: ManagedAgent, event: Record<string, unknown>): void {
  if (event.command !== "prompt" || typeof event.id !== "string" || typeof event.success !== "boolean") return;
  const round = rounds.get(agent);
  if (!round?.pending.delete(event.id)) return;
  if (event.success) {
    round.accepted = true;
    return;
  }
  agent.error = typeof event.error === "string" ? event.error : "RPC prompt rejected";
  // A known preflight rejection is not a process failure. Do not manufacture
  // idleness if another prompt is accepted, awaiting acknowledgement or running.
  if (!round.accepted && round.pending.size === 0 && agent.status === "spawning") {
    agent.status = "idle";
  }
}
