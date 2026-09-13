import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "./agents.ts";
import { AgentManager } from "./agent-manager.ts";
import type { SingleResult, SubagentDetails } from "./subagent-common.ts";

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results: TOut[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Batch and managed delegation use the same guarded RPC admission and ownership path. */
export async function runSingleAgent(
  defaultCwd: string, agents: AgentConfig[], agentName: string, task: string,
  cwd: string | undefined, step: number | undefined, thinkingLevel: string | undefined,
  signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const config = agents.find(a => a.name === agentName);
  const result: SingleResult = {
    agent: agentName, agentSource: config?.source ?? "unknown", task, exitCode: 1,
    messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    step, model: config?.model, thinkingLevel: thinkingLevel ?? config?.thinkingLevel,
  };
  if (!config) { result.stderr = `Unknown agent: ${agentName}`; return result; }
  const manager = new AgentManager();
  try {
    const handle = manager.spawn({
      agentName, task, cwd: cwd ?? defaultCwd, model: config.model,
      thinkingLevel: thinkingLevel ?? config.thinkingLevel, systemPrompt: config.systemPrompt,
      tools: config.tools, signal,
      onUpdate(event) {
        const status = manager.getStatus(event.handle);
        if (!status) return;
        result.usage = status.usage;
        result.messages = manager.getMessages(event.handle) ?? [];
        onUpdate?.({ content: [{ type: "text", text: status.finalOutput || status.status }], details: makeDetails([result]) });
      },
    });
    const status = await manager.wait(handle, undefined, signal);
    if (!status) throw new Error("Child status disappeared");
    result.messages = manager.getMessages(handle) ?? [];
    result.usage = status.usage;
    result.responseModel = status.responseModel;
    result.exitCode = status.error || status.status === "failed" || status.status === "aborted" ? 1 : 0;
    result.errorMessage = status.error;
    result.stderr = status.error ?? "";
    result.sessionFile = status.sessionFile;
    const last = result.messages.findLast(m => m.role === "assistant");
    if (last?.role === "assistant") result.stopReason = last.stopReason;
    return result;
  } finally {
    await manager.cleanup();
  }
}
