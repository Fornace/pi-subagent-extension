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
export function registerManagedWorkspace(pi: ExtensionAPI, agentManager: AgentManager, workspaces: Map<string, Workspace>) {
	pi.registerTool({
		name: "workspace_read",
		label: "Read Workspace",
		description: "Read shared workspace state or files. Use to inspect what child agents have written to their shared workspace.",
		promptSnippet: "Read shared workspace state or files from spawned agents",
		promptGuidelines: ["Use workspace_read to inspect shared state written by spawned agents."],
		parameters: Type.Object({
			workspaceId: Type.String({ description: "Workspace ID from agent_spawn (with workspace: true)." }),
			key: Type.Optional(Type.String({ description: "Specific state key to read. Omit to read all state." })),
			file: Type.Optional(Type.String({ description: "File name to read from workspace directory." })),
		}),

		async execute(_toolCallId, params) {
			const ws = workspaces.get(params.workspaceId);
			if (!ws) {
				const available = Array.from(workspaces.keys()).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown workspace: ${params.workspaceId}. Available: ${available}` }],
					details: {},
					isError: true,
				};
			}

			if (params.file) {
				const content = ws.readFile(params.file);
				if (content === null) {
					return {
						content: [{ type: "text", text: `File not found: ${params.file}. Files: ${ws.listFiles().join(", ") || "none"}` }],
						details: { workspaceId: params.workspaceId },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { workspaceId: params.workspaceId, file: params.file },
				};
			}

			if (params.key) {
				const value = ws.getKey(params.key);
				return {
					content: [{ type: "text", text: value !== undefined ? JSON.stringify(value, null, 2) : `Key "${params.key}" not found. Keys: ${ws.listKeys().join(", ") || "none"}` }],
					details: { workspaceId: params.workspaceId, key: params.key, value },
				};
			}

			// Return full state + file list
			const state = ws.readState();
			const files = ws.listFiles();
			return {
				content: [{
					type: "text",
					text: `Workspace: ${ws.path}\n\nState:\n${JSON.stringify(state, null, 2)}\n\nFiles: ${files.join(", ") || "none"}`,
				}],
				details: { workspaceId: params.workspaceId, state, files },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("workspace_read ")) + theme.fg("accent", args.workspaceId || "?");
			if (args.key) text += theme.fg("muted", ` key:${args.key}`);
			if (args.file) text += theme.fg("muted", ` file:${args.file}`);
			return new Text(text, 0, 0);
		},
	});
}
