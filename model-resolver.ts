/**
 * ModelResolver — resolves frontier model keys to available provider/model combos
 *
 * Uses pi-frontier's route table to find the cheapest available provider for a model.
 * Checks which providers the user has configured via environment variables and Pi's model registry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findRoutes, getFrontierModels, getRoutes } from "pi-frontier";

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
  qwenmax: "alibaba-cloud/qwen-max",
  qwen37max: "alibaba-cloud/qwen-max",
  qwenflash: "alibaba-cloud/qwen-flash",
  gemini31pro: "google/gemini-3.1-pro-preview",
  gemini35flash: "google/gemini-3.5-flash",
  deepseekv4pro: "alibaba-cloud/deepseek-v4-pro",
  gpt55: "openai-codex/gpt-5.5",
};

const ALIAS_CANDIDATES: Record<string, string[]> = {
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
 * If nothing matches, fall back to the dispatching agent's current model.
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

  return fallback;
}

// ─── Provider Detection ──────────────────────────────────────────────────────

/** Common provider → environment variable mappings */
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  alibaba: ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  deepinfra: ["DEEPINFRA_API_KEY"],
  groq: ["GROQ_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  "github-copilot": ["GITHUB_TOKEN"],
};

/** Check which providers have API keys available */
export function getAvailableProviders(): Set<string> {
  const available = new Set<string>();

  for (const [provider, envKeys] of Object.entries(PROVIDER_ENV_KEYS)) {
    for (const key of envKeys) {
      if (process.env[key]) {
        available.add(provider);
        break;
      }
    }
  }

  // Also check for generic patterns like *_API_KEY
  for (const [key, value] of Object.entries(process.env)) {
    if (value && key.endsWith("_API_KEY")) {
      const provider = key.replace("_API_KEY", "").toLowerCase();
      available.add(provider);
    }
  }

  return available;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve a frontier model key to the best available provider/model-id.
 *
 * Strategy:
 * 1. Check if model's direct provider is available (e.g., google/gemini-3.1-pro with GEMINI_API_KEY)
 * 2. If not, find cheapest route from available third-party providers
 * 3. Fall back to original model key if nothing works
 *
 * @param modelKey - Frontier model key (e.g., "google/gemini-3.1-pro-preview")
 * @param preferredProvider - Optional preferred provider override
 * @returns Resolved model info, or null if no route found
 */
export function resolveModel(
  modelKey: string,
  preferredProvider?: string,
  availableProviders?: Set<string>,
): ResolvedModel | null {
  const providers = availableProviders ?? getAvailableProviders();
  
  // Parse the model key to extract provider/model
  const parts = modelKey.split("/");
  const directProvider = parts.length > 1 ? parts[0] : null;
  const modelId = parts.length > 1 ? parts.slice(1).join("/") : modelKey;
  
  // Check if direct provider is available
  if (directProvider && providers.has(directProvider)) {
    // Use direct provider - findRoutes needs just the model name
    const matches = findRoutes(modelId);
    const frontier = matches.length > 0 ? matches[0].frontier : null;
    
    return {
      modelKey,
      provider: directProvider,
      frontierKey: frontier?.model_key || modelKey,
      // Convert per-token costs to per-1M-token costs
      inputCost: frontier?.input_cost ? frontier.input_cost * 1_000_000 : 0,
      outputCost: frontier?.output_cost ? frontier.output_cost * 1_000_000 : 0,
      isCheapest: true,
      routes: [],
    };
  }
  
  // Try to find routes from third-party providers
  const matches = findRoutes(modelId);
  if (matches.length === 0) {
    // Not a frontier model — pass through as-is
    return {
      modelKey,
      provider: directProvider || "unknown",
      frontierKey: modelKey,
      inputCost: 0,
      outputCost: 0,
      isCheapest: true,
      routes: [],
    };
  }

  const frontier = matches[0].frontier;
  const allRoutes: RouteInfo[] = (matches[0].routes || []).map((r: any) => ({
    provider: r.provider,
    modelKey: r.model_key,
    modelId: r.model_id,
    inputCost: r.input_cost,
    outputCost: r.output_cost,
    maxInputTokens: r.max_input_tokens,
    maxOutputTokens: r.max_output_tokens,
  }));

  // Filter to available providers
  let candidateRoutes = allRoutes.filter((r) => providers.has(r.provider));

  // If preferred provider specified, try that first
  if (preferredProvider) {
    const preferred = candidateRoutes.find((r) => r.provider === preferredProvider);
    if (preferred) {
      return {
        modelKey: preferred.modelKey,
        provider: preferred.provider,
        frontierKey: frontier?.model_key || modelKey,
        inputCost: preferred.inputCost,
        outputCost: preferred.outputCost,
        isCheapest: preferred === candidateRoutes[0],
        routes: allRoutes,
      };
    }
  }

  // Use cheapest available route
  if (candidateRoutes.length > 0) {
    const cheapest = candidateRoutes[0]; // Already sorted by cost
    return {
      modelKey: cheapest.modelKey,
      provider: cheapest.provider,
      frontierKey: frontier?.model_key || modelKey,
      inputCost: cheapest.inputCost,
      outputCost: cheapest.outputCost,
      isCheapest: true,
      routes: allRoutes,
    };
  }

  // No available provider — return the direct frontier key and let Pi handle it
  return {
    modelKey: frontier?.model_key || modelKey,
    provider: frontier?.provider || directProvider || "unknown",
    frontierKey: frontier?.model_key || modelKey,
    // Convert per-token costs to per-1M-token costs
    inputCost: frontier?.input_cost ? frontier.input_cost * 1_000_000 : 0,
    outputCost: frontier?.output_cost ? frontier.output_cost * 1_000_000 : 0,
    isCheapest: true,
    routes: allRoutes,
  };
}

/**
 * Get all frontier models with their info for the settings browser.
 */
export function getAllFrontierModels(): FrontierModelInfo[] {
  const models = getFrontierModels();
  return models.map((m: any) => ({
    modelKey: m.model_key,
    provider: m.provider,
    family: m.family,
    version: m.version,
    tier: m.tier,
    maxInputTokens: m.max_input_tokens || 0,
    maxOutputTokens: m.max_output_tokens || 0,
    inputCost: m.input_cost ? m.input_cost * 1_000_000 : 0,
    outputCost: m.output_cost ? m.output_cost * 1_000_000 : 0,
    reasoning: !!m.reasoning,
    toolCall: !!m.tool_call,
    vision: m.modalities?.input?.includes("image") || false,
    openWeights: !!m.open_weights,
    knowledge: m.knowledge,
  }));
}

/**
 * Filter frontier models by capabilities.
 */
export function filterFrontierModels(filters: {
  reasoning?: boolean;
  tools?: boolean;
  vision?: boolean;
  openWeights?: boolean;
  minContext?: number;
  maxInputCost?: number;
  maxOutputCost?: number;
}): FrontierModelInfo[] {
  let models = getAllFrontierModels();

  if (filters.reasoning) models = models.filter((m) => m.reasoning);
  if (filters.tools) models = models.filter((m) => m.toolCall);
  if (filters.vision) models = models.filter((m) => m.vision);
  if (filters.openWeights) models = models.filter((m) => m.openWeights);
  if (filters.minContext) models = models.filter((m) => m.maxInputTokens >= filters.minContext!);
  if (filters.maxInputCost) models = models.filter((m) => m.inputCost <= filters.maxInputCost!);
  if (filters.maxOutputCost) models = models.filter((m) => m.outputCost <= filters.maxOutputCost!);

  return models;
}

/**
 * Format cost for display.
 */
export function formatCost(inputCost: number, outputCost: number): string {
  const fmt = (c: number) => {
    if (c === 0) return "$0";
    if (c < 0.01) return `$${c.toFixed(4)}`;
    if (c < 1) return `$${c.toFixed(2)}`;
    return `$${c.toFixed(2)}`;
  };
  return `${fmt(inputCost)}/${fmt(outputCost)}`;
}

/**
 * Format token count for display.
 */
export function formatTokens(tokens: number): string {
  if (!tokens) return "?";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
