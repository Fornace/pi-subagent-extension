import { rpcSend, getFinalOutput, type ManagedAgent } from "./agent-manager-support.ts";
import { observePromptResponse } from "./agent-rpc-prompts.ts";
import { reportUsage, reportYield } from "./usage-receipts.ts";
import { acquire, release, terminateChild, IDLE_REAP_MS, childPaused } from "./child-lifecycle.ts";

export function observeAgentEvent(agent: ManagedAgent, event: any): void {
    const proc = agent.process;
    if (!proc) throw new Error("RPC event received before child launch");
    // Auto-respond to extension UI requests (cancel all dialogs)
    if (event.type === "extension_ui_request") {
      if (event.method === "setStatus" && event.statusKey === "subagent-guard") {
        const guard = JSON.parse(event.statusText);
        observeAgentEvent(agent, { ...guard, type: "subagent_guard" });
        return;
      }
      if (!["select", "confirm", "input", "editor"].includes(event.method)) return;
      const response: Record<string, unknown> = {
        type: "extension_ui_response",
        id: event.id,
        cancelled: true,
      };
      try { rpcSend(agent.stdin, response); } catch {}
      return;
    }

    // Track agent lifecycle
    switch (event.type) {
      case "agent_start":
        if (agent.status === "aborted" || agent.status === "failed") return;
        acquire(agent.handle);
        agent.status = "running";
        break;

      case "agent_end":
        // message_end is authoritative. agent_end repeats decoded message copies.
        agent.finalOutput = getFinalOutput(agent.messages);
        break;

      case "agent_settled":
        // agent_end can precede retry, compaction and queued continuations.
        // Only the session-level settled event proves reusable prompt idleness.
        if (agent.status === "running" || agent.status === "spawning") {
          agent.status = "idle";
          release(agent.handle);
          clearTimeout(agent.idleTimer);
          agent.idleTimer = setTimeout(() => {
            if (agent.status === "idle") terminateChild(proc);
          }, IDLE_REAP_MS);
          agent.idleTimer.unref();
        }
        agent.finalOutput = getFinalOutput(agent.messages);
        {
          const last = agent.messages.findLast(message => message.role === "assistant");
          if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
            agent.error = last.errorMessage || `Agent prompt ${last.stopReason}`;
          }
        }
        break;

      case "subagent_guard":
        if (event.state === "paused" && event.outcome === "budget_yield") {
          agent.guardState = "yielded";
          agent.status = "yielded";
          agent.yieldReason = event.reason;
          agent.finalOutput = getFinalOutput(agent.messages);
          agent.endTime = Date.now();
          reportYield(agent, event);
          terminateChild(proc);
        } else {
          agent.guardState = event.state;
          if (event.state === "paused") {
            agent.error = `Child guard paused: ${event.reason}`;
            childPaused(`${agent.handle}: ${agent.error}`);
            agent.status = "failed";
            terminateChild(proc);
          }
        }
        break;

      case "response":
        if (event.id === "guard-preflight") {
          clearTimeout(agent.preflightTimer);
          const required = ["mantice-guard", "mantice-child-budget", "subagent-owner-ready"];
          if (!event.success || !required.every(name => event.data?.commands?.some((c: { name: string }) => c.name === name))) {
            agent.status = "failed";
            agent.error = "Child lacks required guard, lifetime budget, or ownership capability. Inspect child extension errors and install coordinated repairs.";
            terminateChild(proc);
          } else {
            agent.guardVerified = true;
            agent.startPrompt();
          }
        } else {
          observePromptResponse(agent, event);
          if (agent.status === "idle") {
            release(agent.handle);
            clearTimeout(agent.idleTimer);
            agent.idleTimer = setTimeout(() => {
              if (agent.status === "idle") terminateChild(proc);
            }, IDLE_REAP_MS);
            agent.idleTimer.unref();
          }
        }
        break;

      case "message_end":
        if (event.message?.role === "assistant") {
          agent.messages.push(event.message);
          agent.usage.turns++;
          const usage = event.message.usage;
          if (usage) {
            agent.usage.input += usage.input || 0;
            agent.usage.output += usage.output || 0;
            agent.usage.cacheRead += usage.cacheRead || 0;
            agent.usage.cacheWrite += usage.cacheWrite || 0;
            agent.usage.cost += usage.cost?.total || 0;
            agent.usage.contextTokens = usage.totalTokens || 0;
          }
          if (event.message.model) agent.responseModel = event.message.model;
          reportUsage(agent, event);
          if (!agent.model && event.message.model) {
            agent.model = event.message.model;
          }
        }
        if (event.message?.role === "toolResult") {
          agent.messages.push(event.message);
        }
        break;

      case "tool_execution_start":
      case "tool_execution_end":
        // Track for progress reporting
        break;
    }

}
