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
import { runSingleAgent, mapWithConcurrencyLimit } from "./subagent-runner.ts";
import type { OnUpdateCallback } from "./subagent-runner.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentParams } from "./subagent-tool.ts";
export const batchExecute: Pick<ToolDefinition<typeof SubagentParams, SubagentDetails>, "execute"> = {
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const discoveredAgents = discovery.agents;
			const agentSettings = loadAgentSettings(ctx);
			const resolutionErrors = new Map<string, string>();
			const agents: AgentConfig[] = discoveredAgents.map((agent) => {
				const requested = agentSettings[agent.name]?.model ?? agent.model;
				const resolved = resolveAgentModel(requested, ctx.modelRegistry, ctx.model);
				if (requested && requested !== "default" && !resolved) {
					resolutionErrors.set(agent.name, `Requested model did not resolve: ${requested}`);
				}
				return { ...agent, model: resolved?.modelKey };
			});
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean((params.agent || params.model) && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const runNamedAgent = async (
				agentName: string, task: string, cwd: string | undefined, step: number | undefined,
				thinkingLevel: string | undefined, update: OnUpdateCallback | undefined, details: (results: SingleResult[]) => SubagentDetails,
			) => {
				const resolutionError = resolutionErrors.get(agentName);
				if (resolutionError) {
					return { agent: agentName, agentSource: "unknown" as const, task, exitCode: 1, messages: [],
						stderr: resolutionError, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
						cost: 0, contextTokens: 0, turns: 0 }, step };
				}
				return runSingleAgent(ctx.cwd, agents, agentName, task, cwd, step, thinkingLevel, signal, update, details);
			};

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
				throw new Error(`Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`);
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

					const result = await runNamedAgent(
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						undefined,
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
					const result = await runNamedAgent(
						t.agent,
						t.task,
						t.cwd,
						undefined,
						undefined,
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
						throw new Error(`Unknown agent: "${params.agent}". Available agents: ${available}. Or specify a model directly.`);
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
					throw new Error(`No agent or model specified. Available agents: ${available}.`);
				}

				// Apply model override to named agent
				if (params.model) {
					const resolvedOverride = resolveAgentModel(params.model, ctx.modelRegistry, ctx.model);
					if (!resolvedOverride) {
						throw new Error(`Requested model did not resolve: ${params.model}. No agent was spawned.`);
					}
					resolvedAgent = { ...resolvedAgent, model: resolvedOverride.modelKey };
				}

				const result = await runSingleAgent(
					ctx.cwd,
					[...agents.filter(agent => agent.name !== resolvedAgent!.name), resolvedAgent],
					resolvedAgent.name,
					params.task!,
					params.cwd,
					undefined,
					params.thinkingLevel,
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
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			throw new Error(`Invalid parameters. Available agents: ${available}`);
		},
};
