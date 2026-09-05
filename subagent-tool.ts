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
import { batchExecute } from "./subagent-execute.ts";
import { batchRender } from "./subagent-render.ts";
const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode). Always prefer named agents." })),
	model: Type.Optional(Type.String({ description: "Model ID to use directly. ONLY use when no named agent fits the task. Prefer named agents (scout, planner, builder, critic, operator)." })),
	thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking level override for the subagent." })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export function registerBatch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

...batchExecute,
...batchRender,
});
}
