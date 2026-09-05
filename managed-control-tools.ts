import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { AgentManager } from "./agent-manager.ts";
import { Workspace } from "./workspace.ts";
import { resolveAgentModel } from "./model-resolver.ts";
import { loadAgentSettings, registerAgentsCommand } from "./settings-page.ts";
import { MAX_PARALLEL_TASKS, MAX_CONCURRENCY, COLLAPSED_ITEM_COUNT, PER_TASK_OUTPUT_CAP, formatTokens, formatUsageStats, hasReportedUsage, formatManagedUsage, formatManagedCost, formatManagedTokens, formatToolCall, getFinalOutput, isFailedResult, getResultOutput, truncateParallelOutput, getDisplayItems } from "./subagent-common.ts";
import type { UsageStats, SingleResult, SubagentDetails, DisplayItem } from "./subagent-common.ts";
export function registerManagedControl(pi: ExtensionAPI, agentManager: AgentManager, workspaces: Map<string, Workspace>) {
	pi.registerTool({
		name: "agent_steer",
		label: "Steer Agent",
		description: "Send a steering message to a running spawned agent. Delivered after the agent's current turn finishes its tool calls, before the next LLM call. Use this to redirect, add context, or change priorities mid-flight.",
		promptSnippet: "Send a steering message to a running spawned agent",
		promptGuidelines: ["Use agent_steer to redirect a running agent or inject new instructions mid-flight."],
		parameters: Type.Object({
			handle: Type.String({ description: "Agent handle from agent_spawn." }),
			message: Type.String({ description: "Steering message to deliver." }),
		}),

		async execute(_toolCallId, params) {
			const sent = agentManager.steer(params.handle, params.message);
			if (!sent) {
				const status = agentManager.getStatus(params.handle);
				return {
					content: [{ type: "text", text: status
						? `Cannot steer: agent ${params.handle} is ${status.status}.`
						: `Unknown agent handle: ${params.handle}. Use agent_list to see running agents.`
					}],
					details: { handle: params.handle, sent: false },
					isError: !status,
				};
			}
			return {
				content: [{ type: "text", text: `Steered ${params.handle}: "${params.message}"` }],
				details: { handle: params.handle, sent: true },
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("agent_steer ")) +
				theme.fg("accent", args.handle || "?") +
				theme.fg("dim", ` → ${(args.message || "").slice(0, 60)}`),
				0, 0
			);
		},
	});

	// ── agent_interrupt ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent_interrupt",
		label: "Interrupt Agent",
		description: "Interrupt/abort a running spawned agent. Sends abort command via RPC and kills the process after 5s if it doesn't stop.",
		promptSnippet: "Interrupt and stop a running spawned agent",
		promptGuidelines: ["Use agent_interrupt to stop a running agent that is going off-track or no longer needed."],
		parameters: Type.Object({
			handle: Type.String({ description: "Agent handle from agent_spawn." }),
			reason: Type.Optional(Type.String({ description: "Reason for interruption." })),
		}),

		async execute(_toolCallId, params) {
			const interrupted = agentManager.interrupt(params.handle, params.reason);
			if (!interrupted) {
				const status = agentManager.getStatus(params.handle);
				return {
					content: [{ type: "text", text: status
						? `Cannot interrupt: agent ${params.handle} is already ${status.status}.`
						: `Unknown agent handle: ${params.handle}.`
					}],
					details: { handle: params.handle, interrupted: false },
					isError: !status,
				};
			}
			const status = agentManager.getStatus(params.handle);
			return {
				content: [{ type: "text", text: `Interrupted ${params.handle}${params.reason ? `: ${params.reason}` : ""}.\nOutput so far: ${status?.finalOutput?.slice(0, 500) || "(none)"}` }],
				details: { handle: params.handle, interrupted: true, status },
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("agent_interrupt ")) +
				theme.fg("error", args.handle || "?") +
				(args.reason ? theme.fg("muted", ` (${args.reason})`) : ""),
				0, 0
			);
		},
	});
	pi.registerTool({
		name: "agent_status",
		label: "Agent Status",
		description: "Get the current status of a spawned agent without blocking. Returns status, usage, and any output so far.",
		promptSnippet: "Check status of a spawned agent without waiting",
		promptGuidelines: ["Use agent_status for non-blocking status checks on running agents."],
		parameters: Type.Object({
			handle: Type.String({ description: "Agent handle from agent_spawn." }),
		}),

		async execute(_toolCallId, params) {
			const status = agentManager.getStatus(params.handle);
			if (!status) {
				return {
					content: [{ type: "text", text: `Unknown agent handle: ${params.handle}. Use agent_list to see running agents.` }],
					details: {},
					isError: true,
				};
			}
			const elapsed = (status.elapsedMs / 1000).toFixed(1);
			const lines = [
				`Agent: ${status.handle}`,
				`Model: ${status.model || "default"}`,
				`Status: ${status.status}`,
				`Elapsed: ${elapsed}s`,
				`Turns: ${status.usage.turns}`,
				`Cost: ${formatManagedCost(status.usage)}`,
				`Tokens: ${formatManagedTokens(status.usage)}`,
			];
			if (status.workspaceId) lines.push(`Workspace: ${status.workspaceId}`);
			if (status.finalOutput) lines.push(`\nOutput:\n${status.finalOutput.slice(0, 500)}`);
			if (status.error) lines.push(`\nError: ${status.error}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { handle: params.handle, status },
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("agent_status ")) + theme.fg("accent", args.handle || "?"),
				0, 0
			);
		},
	});

	// ── agent_list ───────────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent_list",
		label: "List Agents",
		description: "List all spawned agents and their current status. Use this to see which agents are running, idle, or completed.",
		promptSnippet: "List all spawned agents and their status",
		promptGuidelines: ["Use agent_list to see all spawned agents before steering or waiting."],
		parameters: Type.Object({}),

		async execute() {
			const agents = agentManager.list();
			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No spawned agents. Use agent_spawn to create one." }],
					details: { agents: [] },
				};
			}
			const lines = agents.map((a) => {
				const elapsed = (a.elapsedMs / 1000).toFixed(1);
				const icon = a.status === "running" ? "●" : a.status === "completed" ? "✓" : a.status === "aborted" ? "⊘" : a.status === "failed" ? "✗" : "○";
				return `${icon} ${a.handle} (${a.model || "default"}) — ${a.status} ${elapsed}s ${formatManagedUsage(a.usage, true)}`;
			});
			return {
				content: [{ type: "text", text: `Spawned agents (${agents.length}):\n${lines.join("\n")}` }],
				details: { agents },
			};
		},

		renderResult(result, _opts, theme) {
			const agents = (result.details as any)?.agents || [];
			if (agents.length === 0) return new Text(theme.fg("muted", "No spawned agents"), 0, 0);

			let text = theme.fg("toolTitle", theme.bold(`Agents (${agents.length})`));
			for (const a of agents) {
				const icon = a.status === "running" ? theme.fg("success", "●")
					: a.status === "completed" ? theme.fg("success", "✓")
					: a.status === "aborted" ? theme.fg("warning", "⊘")
					: a.status === "failed" ? theme.fg("error", "✗")
					: theme.fg("muted", "○");
				const elapsed = (a.elapsedMs / 1000).toFixed(1);
				text += `\n  ${icon} ${theme.fg("accent", a.handle)} ${theme.fg("muted", a.status)} ${theme.fg("dim", `${elapsed}s`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
