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
export function registerManagedSpawn(pi: ExtensionAPI, agentManager: AgentManager, workspaces: Map<string, Workspace>) {
	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn Agent",
		description: [
			"Spawn a child agent that runs in the background with bidirectional communication.",
			"Returns a handle you can use with agent_steer, agent_interrupt, agent_wait, and agent_status.",
			"Unlike 'subagent' (fire-and-forget), spawned agents can be steered, interrupted, and monitored in real-time.",
			"Use workspace: true to create a shared workspace for cross-agent file communication.",
		].join(" "),
		promptSnippet: "Spawn a background child agent with steer/interrupt/wait control",
		promptGuidelines: [
			"Always prefer named agents (scout, planner, builder, critic, operator) over raw model IDs.",
			"Only use the 'model' parameter when no named agent fits the task.",
			"Use agent_spawn for tasks that may need mid-flight steering or coordination with other agents.",
			"Use 'subagent' for simple fire-and-forget delegation.",
			"Set workspace: true when agents need to share files or state.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Named agent from ~/.pi/agent/agents/. Omit if using model directly." })),
			model: Type.Optional(Type.String({ description: "Model ID (e.g. 'anthropic/claude-sonnet-4-5', 'openai/gpt-4o'). ONLY use when no named agent fits the task. Prefer named agents." })),
			task: Type.String({ description: "Task to delegate to the child agent." }),
			systemPrompt: Type.Optional(Type.String({ description: "Additional system prompt (merged with agent's system prompt if both provided)." })),
			workspace: Type.Optional(Type.Boolean({ description: "Create a shared workspace directory for cross-agent file communication. Default: false." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Override tool list for the child agent." })),
			agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { description: 'Agent scope for named agents. Default: "user".' })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			// Resolve agent config
			let agentConfig: AgentConfig | null = null;
			if (params.agent) {
				agentConfig = agents.find((a) => a.name === params.agent) ?? null;
				if (!agentConfig && !params.model) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}. Or use 'model' directly.` }],
						details: {},
						isError: true,
					};
				}
			}

			// Resolve model through persisted /agents overrides, then Pi's registered provider registry.
			// If there is no match, inherit the dispatching agent's current model.
			const agentSettings = loadAgentSettings(ctx);
			const agentOverride = agentConfig ? agentSettings[agentConfig.name] : undefined;
			const requestedModel = params.model ?? agentOverride?.model ?? agentConfig?.model;
			const resolved = resolveAgentModel(requestedModel, ctx.modelRegistry, ctx.model);
			const resolvedModel = resolved?.modelKey;
			const provider = resolved?.provider || ctx.model?.provider || "unknown";
			const inherited = resolved?.frontierKey === "dispatching-agent";
			let costInfo = inherited ? " (inherited from dispatching agent)" : "";
			if (resolved && !inherited && (resolved.inputCost || resolved.outputCost)) {
				costInfo = ` ($${resolved.inputCost.toFixed(2)}/${resolved.outputCost.toFixed(2)}/1M)`;
			}

			const resolvedName = params.agent ?? (params.model ? `adhoc-${params.model.split("/").pop()}` : "agent");
			const resolvedSystemPrompt = [agentConfig?.systemPrompt, params.systemPrompt].filter(Boolean).join("\n\n");
			const resolvedTools = params.tools ?? agentConfig?.tools;

			// Create workspace if requested
			let ws: Workspace | undefined;
			if (params.workspace) {
				ws = new Workspace();
				workspaces.set(ws.id, ws);
			}

			// Spawn the agent
			const handle = agentManager.spawn({
				agentName: resolvedName,
				model: resolvedModel,
				systemPrompt: resolvedSystemPrompt || undefined,
				task: params.task,
				cwd: ctx.cwd,
				workspaceId: ws?.id,
				workspace: ws,
				signal,
				tools: resolvedTools,
				onUpdate: (event) => {
					if (onUpdate && (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "agent_end")) {
						const status = agentManager.getStatus(handle);
						onUpdate({
							content: [{ type: "text", text: status?.finalOutput || `Agent ${handle}: ${status?.status} (${status?.usage.turns || 0} turns)` }],
							details: { handle, status },
						});
					}
				},
			});

			const status = agentManager.getStatus(handle)!;
			const wsInfo = ws ? `\nWorkspace: ${ws.path}\nState: ${ws.filePath("state.json")}` : "";
			const modelInfo = resolvedModel
				? `${resolvedModel} via ${provider}${costInfo}`
				: "default model";

			return {
				content: [{
					type: "text",
					text: `Spawned agent **${handle}** (${modelInfo})\nTask: ${params.task.slice(0, 200)}${params.task.length > 200 ? "..." : ""}${wsInfo}\n\nUse agent_steer to redirect, agent_interrupt to stop, agent_wait to collect results.`,
				}],
				details: { handle, status, workspacePath: ws?.path, provider, costInfo },
			};
		},

		renderCall(args, theme) {
			const agent = args.agent || args.model || "adhoc";
			const task = (args.task || "").slice(0, 60);
			const ws = args.workspace ? theme.fg("accent", " +workspace") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("agent_spawn ")) +
				theme.fg("accent", agent) + ws +
				theme.fg("dim", `\n  ${task}${(args.task || "").length > 60 ? "..." : ""}`),
				0, 0
			);
		},

		renderResult(result, _opts, theme) {
			const handle = (result.details as any)?.handle;
			const status = (result.details as any)?.status;
			if (handle) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("accent", handle) +
					theme.fg("muted", ` ${status?.status || "spawned"}`),
					0, 0
				);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
