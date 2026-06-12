/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

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

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

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
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode). Omit if using 'model' directly." })),
	model: Type.Optional(Type.String({ description: "Model ID to use directly (e.g. 'anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-2.5-pro'). Use instead of or to override 'agent'." })),
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

export default function (pi: ExtensionAPI) {
	// Register /agents settings command
	registerAgentsCommand(pi);

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

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean((params.agent || params.model) && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent || (params.model && params.task)) {
				// Resolve agent: named, ad-hoc from model, or error
				let resolvedAgent: AgentConfig | null = null;
				if (params.agent) {
					resolvedAgent = agents.find((a) => a.name === params.agent) ?? null;
					if (!resolvedAgent && !params.model) {
						const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
						return {
							content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available agents: ${available}. Or use 'model' to specify any model directly.` }],
							details: makeDetails("single")([]),
						};
					}
				}
				if (!resolvedAgent && params.model) {
					resolvedAgent = {
						name: params.agent || "adhoc",
						description: "Ad-hoc agent",
						tools: undefined,
						model: params.model,
						systemPrompt: "",
						source: "user" as const,
						filePath: "",
					};
				}
				if (!resolvedAgent) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						content: [{ type: "text", text: `No agent or model specified. Available agents: ${available}. Or use 'model' to specify any model directly.` }],
						details: makeDetails("single")([]),
					};
				}

				// Apply model override to named agent
				if (params.model && params.agent && resolvedAgent) {
					resolvedAgent = { ...resolvedAgent, model: params.model };
				}

				const result = await runSingleAgent(
					ctx.cwd,
					[...agents, resolvedAgent],
					resolvedAgent.name,
					params.task!,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || args.model || "...";
			const isAdhoc = !args.agent && !!args.model;
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg(isAdhoc ? "warning" : "accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			if (args.model && args.agent) text += theme.fg("warning", ` → ${args.model}`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ─── Managed Agent Tools (RPC-based, steer/interrupt/wait) ─────────────

	const agentManager = new AgentManager();
	const workspaces = new Map<string, Workspace>();

	// Cleanup on session shutdown
	pi.on("session_shutdown", async () => {
		await agentManager.cleanup();
		for (const ws of workspaces.values()) ws.destroy();
		workspaces.clear();
	});

	// ── agent_spawn ──────────────────────────────────────────────────────────

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
			"Use agent_spawn for tasks that may need mid-flight steering or coordination with other agents.",
			"Use 'subagent' for simple fire-and-forget delegation.",
			"Set workspace: true when agents need to share files or state.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Named agent from ~/.pi/agent/agents/. Omit if using model directly." })),
			model: Type.Optional(Type.String({ description: "Model ID (e.g. 'anthropic/claude-sonnet-4-5', 'openai/gpt-4o'). Used for ad-hoc agents or to override named agent model." })),
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

	// ── agent_steer ──────────────────────────────────────────────────────────

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

	// ── agent_wait ───────────────────────────────────────────────────────────

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
						content: [{ type: "text", text: `Waiting for ${params.handle}: ${status.status} (${status.usage.turns} turns, $${status.usage.cost.toFixed(4)})` }],
						details: { handle: params.handle, status },
					});
				}
			}, 3000);

			try {
				const result = await agentManager.wait(params.handle, timeoutMs > 0 ? timeoutMs : undefined);
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
				const usageStr = `${result.usage.turns} turns, $${result.usage.cost.toFixed(4)}`;
				const statusIcon = result.status === "completed" ? "✓" : result.status === "aborted" ? "⊘" : "✗";

				return {
					content: [{
						type: "text",
						text: `${statusIcon} Agent ${params.handle} ${result.status} (${elapsed}s, ${usageStr})\n\n${output}`,
					}],
					details: { handle: params.handle, status: result },
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

			const icon = status.status === "completed" ? theme.fg("success", "✓")
				: status.status === "aborted" ? theme.fg("warning", "⊘")
				: theme.fg("error", "✗");
			const elapsed = (status.elapsedMs / 1000).toFixed(1);
			const usageStr = `${status.usage.turns}t $${status.usage.cost.toFixed(4)}`;

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

	// ── agent_status ─────────────────────────────────────────────────────────

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
				`Cost: $${status.usage.cost.toFixed(4)}`,
				`Tokens: ${status.usage.input}↑ ${status.usage.output}↓`,
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
				return `${icon} ${a.handle} (${a.model || "default"}) — ${a.status} ${elapsed}s ${a.usage.turns}t $${a.usage.cost.toFixed(4)}`;
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

	// ── workspace_read ───────────────────────────────────────────────────────

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
