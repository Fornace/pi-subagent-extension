/**
 * ModelResolver — resolves frontier model keys to available provider/model combos
 *
 * Uses pi-frontier's route table to find the cheapest available provider for a model.
 * Checks which providers the user has configured via environment variables and Pi's model registry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedModel {
  /** The provider/model-id string to pass to --model */
  modelKey: string;
  /** Which provider is serving it */
  provider: string;
  /** Original frontier model key */
  frontierKey: string;
  /** Cost per 1M tokens */
  inputCost: number;
  outputCost: number;
  /** Whether this is the cheapest route */
  isCheapest: boolean;
  /** All available routes */
  routes: RouteInfo[];
}

export interface RouteInfo {
  provider: string;
  modelKey: string;
  modelId: string;
  inputCost: number;
  outputCost: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface FrontierModelInfo {
  modelKey: string;
  provider: string;
  family: string;
  version: string;
  tier: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputCost: number;
  outputCost: number;
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
  openWeights: boolean;
  knowledge?: string;
}

interface PiModelLike {
  id: string;
  provider: string;
  name?: string;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface PiModelRegistryLike {
  getAvailable?: () => PiModelLike[];
  getAll?: () => PiModelLike[];
  find?: (provider: string, modelId: string) => PiModelLike | undefined;
  hasConfiguredAuth?: (model: PiModelLike) => boolean;
}

const DIRECT_PI_ALIASES: Record<string, string> = {
  fornaceflash: "mantice/fornace-flash",
  fornacefast: "mantice/fornace-fast",
  fornacereasoning: "mantice/fornace-reasoning",
  fornacemax: "mantice/fornace-max",
  fornaceastra: "mantice/fornace-astra",
  qwenmax: "alibaba-cloud/qwen-max",
  qwen37max: "alibaba-cloud/qwen-max",
  qwenflash: "alibaba-cloud/qwen-flash",
  gemini31pro: "google/gemini-3.1-pro-preview",
  gemini35flash: "google/gemini-3.5-flash",
  deepseekv4pro: "alibaba-cloud/deepseek-v4-pro",
  gpt55: "openai-codex/gpt-5.5",
};

const ALIAS_CANDIDATES: Record<string, string[]> = {
  fornaceflash: ["fornace-flash"],
  fornacefast: ["fornace-fast"],
  fornacereasoning: ["fornace-reasoning"],
  fornacemax: ["fornace-max"],
  fornaceastra: ["fornace-astra"],
  qwenmax: ["qwen-max", "qwen3.7-max", "qwen3.7-max-preview", "qwen3.7-max-2026-06-08"],
  qwen37max: ["qwen-max", "qwen3.7-max", "qwen3.7-max-preview", "qwen3.7-max-2026-06-08"],
  qwenflash: ["qwen-flash", "qwen3.6-flash", "qwen3.6-35b-a3b"],
  gemini31pro: ["gemini-3.1-pro-preview", "gemini-3.1-pro"],
  gemini35flash: ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-flash"],
  deepseekv4pro: ["deepseek-v4-pro"],
  gpt55: ["gpt-5.5"],
};

function normalizeModelKey(value: string | undefined): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function modelKey(model: PiModelLike): string {
  return `${model.provider}/${model.id}`;
}

function readEnabledModels(): string[] {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  } catch {
    return [];
  }
}

function perMillion(cost: number | undefined): number {
  if (!cost) return 0;
  return cost < 0.01 ? cost * 1_000_000 : cost;
}

function toResolved(model: PiModelLike, frontierKey: string, routes: RouteInfo[] = []): ResolvedModel {
  return {
    modelKey: modelKey(model),
    provider: model.provider,
    frontierKey,
    inputCost: perMillion(model.cost?.input),
    outputCost: perMillion(model.cost?.output),
    isCheapest: true,
    routes,
  };
}

function toDirectResolved(modelId: string, frontierKey: string): ResolvedModel {
  const [provider, ...rest] = modelId.split("/");
  return {
    modelKey: modelId,
    provider: rest.length ? provider : "unknown",
    frontierKey,
    inputCost: 0,
    outputCost: 0,
    isCheapest: true,
    routes: [],
  };
}

function getRegistryModels(registry?: PiModelRegistryLike): PiModelLike[] {
  if (!registry) return [];
  try {
    const available = registry.getAvailable?.() || [];
    if (available.length) return available;
  } catch {}
  try {
    return registry.getAll?.().filter((m) => !registry.hasConfiguredAuth || registry.hasConfiguredAuth(m)) || [];
  } catch {
    return [];
  }
}

function sortByEnabled(models: PiModelLike[]): PiModelLike[] {
  const enabled = new Set(readEnabledModels().map(normalizeModelKey));
  return [...models].sort((a, b) => {
    const aEnabled = enabled.has(normalizeModelKey(modelKey(a))) || enabled.has(normalizeModelKey(a.id));
    const bEnabled = enabled.has(normalizeModelKey(modelKey(b))) || enabled.has(normalizeModelKey(b.id));
    return Number(bEnabled) - Number(aEnabled);
  });
}

/**
 * Resolve agent model names against Pi's registered/available provider registry first.
 * An absent/default request inherits the dispatching model. An explicit request
 * that cannot be resolved returns null and must fail before spawning.
 */
export function resolveAgentModel(
  requestedModel: string | undefined,
  registry?: PiModelRegistryLike,
  fallbackModel?: PiModelLike,
): ResolvedModel | null {
  const fallback = fallbackModel ? toResolved(fallbackModel, "dispatching-agent") : null;
  if (!requestedModel || requestedModel === "default") return fallback;

  const normalized = normalizeModelKey(requestedModel);
  const models = sortByEnabled(getRegistryModels(registry));
  const candidates = [requestedModel, ...(ALIAS_CANDIDATES[normalized] || [])];
  const normalizedCandidates = candidates.map(normalizeModelKey);

  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      const [provider, ...rest] = candidate.split("/");
      const id = rest.join("/");
      const found = models.find((m) => m.provider === provider && m.id === id);
      if (found) return toResolved(found, requestedModel);
    }
  }

  const exact = models.find((m) => normalizedCandidates.includes(normalizeModelKey(modelKey(m))) || normalizedCandidates.includes(normalizeModelKey(m.id)));
  if (exact) return toResolved(exact, requestedModel);

  const fuzzy = models.find((m) => {
    const id = normalizeModelKey(m.id);
    const key = normalizeModelKey(modelKey(m));
    return normalizedCandidates.some((c) => c && (id.includes(c) || key.includes(c) || c.includes(id)));
  });
  if (fuzzy) return toResolved(fuzzy, requestedModel);

  // Pi provider plugins may accept aliases that are not returned by the live catalog.
  const directAlias = DIRECT_PI_ALIASES[normalized];
  if (directAlias) return toDirectResolved(directAlias, requestedModel);

  return null;
}

export { resolveModel, getAllFrontierModels, filterFrontierModels, formatCost, formatTokens, getAvailableProviders } from "./model-catalog.ts";
