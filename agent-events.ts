import { rpcSend, getFinalOutput, type ManagedAgent } from "./agent-manager-support.ts";
import { observePromptResponse } from "./agent-rpc-prompts.ts";
import { acquire, release, terminateChild, IDLE_REAP_MS, childPaused } from "./child-lifecycle.ts";

export function observeAgentEvent(agent: ManagedAgent, event: any): void {
    // Auto-respond to extension UI requests (cancel all dialogs)
    if (event.type === "extension_ui_request") {
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
          agent.idleTimer = setTimeout(() => {
            if (agent.status === "idle") terminateChild(agent.process);
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
        agent.guardState = event.state;
        if (event.state === "paused") {
          agent.error = `Child guard paused: ${event.reason}`;
          childPaused(`${agent.handle}: ${agent.error}`);
          agent.status = "failed";
          terminateChild(agent.process);
        }
        break;

      case "response":
        if (event.id === "guard-preflight") {
          clearTimeout(agent.preflightTimer);
          if (!event.success || !event.data?.commands?.some((c: { name: string }) => c.name === "mantice-guard")) {
            agent.status = "failed";
            agent.error = "Child lacks repaired Mantice guard. Install it or set PI_SUBAGENT_GUARD_EXTENSION.";
            terminateChild(agent.process);
          } else {
            agent.guardVerified = true;
            agent.startPrompt();
          }
        } else {
          observePromptResponse(agent, event);
          if (agent.status === "idle") {
            release(agent.handle);
            agent.idleTimer = setTimeout(() => terminateChild(agent.process), IDLE_REAP_MS);
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
