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
export function registerManagedWait(pi: ExtensionAPI, agentManager: AgentManager, workspaces: Map<string, Workspace>) {
	pi.registerTool({
		name: "agent_wait",
		label: "Wait for Agent",
		description: "Wait for a spawned agent to complete. Returns the agent's final output and usage stats. Blocks until the agent finishes or the timeout expires.",
		promptSnippet: "Wait for a spawned agent to finish and collect results",
		promptGuidelines: ["Use agent_wait to block until a spawned agent completes and get its output."],
		parameters: Type.Object({
			handle: Type.String({ description: "Agent handle from agent_spawn." }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (0 = wait forever). Default: 120." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const timeoutMs = (params.timeout ?? 120) * 1000;

			// Progress updates while waiting
			const progressInterval = setInterval(() => {
				const status = agentManager.getStatus(params.handle);
				if (status && onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Waiting for ${params.handle}: ${status.status} (${formatManagedUsage(status.usage)})` }],
						details: { handle: params.handle, status },
					});
				}
			}, 3000);

			try {
				const result = await agentManager.wait(params.handle, timeoutMs > 0 ? timeoutMs : undefined, signal);
				clearInterval(progressInterval);

				if (!result) {
					return {
						content: [{ type: "text", text: `Unknown agent handle: ${params.handle}.` }],
						details: { handle: params.handle },
						isError: true,
					};
				}

				const output = result.finalOutput || "(no output)";
				const elapsed = (result.elapsedMs / 1000).toFixed(1);
				const usageStr = formatManagedUsage(result.usage);
                const success = !result.error && (result.status === "idle" || result.status === "completed");
                const statusIcon = success ? "✓" : result.status === "aborted" ? "⊘" : "✗";

				return {
					content: [{
						type: "text",
						text: `${statusIcon} Agent ${params.handle} ${result.status} (${elapsed}s, ${usageStr})\n\n${result.error ? `Error: ${result.error}\n` : ""}${output}`,
					}],
					details: { handle: params.handle, status: result },
					isError: !success,
				};
			} catch (err: any) {
				clearInterval(progressInterval);
				const status = agentManager.getStatus(params.handle);
				return {
					content: [{ type: "text", text: `Wait failed for ${params.handle}: ${err.message}\nPartial output: ${status?.finalOutput?.slice(0, 500) || "(none)"}` }],
					details: { handle: params.handle, error: err.message, status },
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("agent_wait ")) +
				theme.fg("accent", args.handle || "?") +
				(args.timeout ? theme.fg("muted", ` (${args.timeout}s)`) : ""),
				0, 0
			);
		},

		renderResult(result, { expanded }, theme) {
			const status = (result.details as any)?.status;
			if (!status) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const icon = !result.isError && !status.error && (status.status === "completed" || status.status === "idle") ? theme.fg("success", "✓")
				: status.status === "aborted" ? theme.fg("warning", "⊘")
				: theme.fg("error", "✗");
			const elapsed = (status.elapsedMs / 1000).toFixed(1);
			const usageStr = formatManagedUsage(status.usage, true);

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(
					`${icon} ${theme.fg("accent", status.handle)} ${theme.fg("muted", status.status)} ${theme.fg("dim", `${elapsed}s ${usageStr}`)}`,
					0, 0
				));
				if (status.finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(status.finalOutput.trim(), 0, 0, getMarkdownTheme()));
				}
				if (status.error) {
					container.addChild(new Text(theme.fg("error", `Error: ${status.error}`), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("accent", status.handle)} ${theme.fg("muted", status.status)} ${theme.fg("dim", `${elapsed}s ${usageStr}`)}`;
			if (status.finalOutput) {
				const preview = status.finalOutput.slice(0, 200);
				text += `\n${theme.fg("dim", preview)}${status.finalOutput.length > 200 ? "..." : ""}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
