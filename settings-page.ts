/**
 * Settings Page — TUI for editing agent→model associations
 *
 * Registered as `/agents` command. Shows all agents with current model assignments,
 * lets users browse frontier catalog and pick alternatives.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  resolveModel,
  getAllFrontierModels,
  filterFrontierModels,
  formatCost,
  formatTokens,
  getAvailableProviders,
} from "./model-resolver.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";

// ─── Settings Storage ────────────────────────────────────────────────────────

export interface AgentSettings {
  [agentName: string]: {
    model?: string;
    preferredProvider?: string;
  };
}

type SettingsContext = Pick<ExtensionCommandContext, "cwd">;

const SETTINGS_KEY = "agents";

function readSettingsFile(settingsPath: string): Record<string, any> {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch {}
  return {};
}

function userSettingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

function projectSettingsPath(ctx: SettingsContext): string {
  return path.join(ctx.cwd, ".pi", "settings.json");
}

export function loadAgentSettings(ctx?: SettingsContext): AgentSettings {
  // User-level settings are the canonical place for these global agents.
  const userSettings = readSettingsFile(userSettingsPath())[SETTINGS_KEY] || {};

  // Merge legacy/project-local overrides too so older /agents writes are not lost.
  const projectSettings = ctx ? readSettingsFile(projectSettingsPath(ctx))[SETTINGS_KEY] || {} : {};
  return { ...userSettings, ...projectSettings };
}

function saveAgentSettings(_ctx: ExtensionCommandContext, agentSettings: AgentSettings): void {
  const settingsPath = userSettingsPath();
  const settingsDir = path.dirname(settingsPath);
  const settings = readSettingsFile(settingsPath);

  settings[SETTINGS_KEY] = agentSettings;
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

// ─── Settings Page ───────────────────────────────────────────────────────────

export function registerAgentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("agents", {
    description: "Configure agent→model associations",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Agent settings page requires TUI mode", "warning");
        return;
      }

      await showSettingsPage(ctx);
    },
  });
}

async function showSettingsPage(ctx: ExtensionCommandContext): Promise<void> {
  const discovery = discoverAgents(ctx.cwd, "user");
  const agents = discovery.agents;
  const agentSettings = loadAgentSettings(ctx);
  const availableProviders = getAvailableProviders();

  // Build agent list with resolved models
  const agentRows = agents.map((agent) => {
    const override = agentSettings[agent.name];
    const modelKey = override?.model || agent.model || "default";
    const resolved = resolveModel(modelKey, override?.preferredProvider, availableProviders);

    return {
      name: agent.name,
      description: agent.description,
      modelKey,
      resolved: resolved?.modelKey || modelKey,
      provider: resolved?.provider || "unknown",
      cost: resolved ? formatCost(resolved.inputCost, resolved.outputCost) : "?",
      routes: resolved?.routes || [],
    };
  });

  // Show agent list
  const choices = agentRows.map((row) => {
    const modelDisplay = row.resolved === row.modelKey ? row.modelKey : `${row.modelKey} → ${row.resolved}`;
    return `${row.name.padEnd(15)} ${modelDisplay.padEnd(40)} (${row.cost})`;
  });

  const selected = await ctx.ui.select("Select agent to configure:", choices);
  if (!selected) return;

  const selectedIndex = choices.indexOf(selected);
  const agent = agentRows[selectedIndex];

  // Show current config
  ctx.ui.notify(
    `Current: ${agent.name} → ${agent.modelKey}\nProvider: ${agent.provider}\nCost: ${agent.cost}`,
    "info",
  );

  // Offer actions
  const action = await ctx.ui.select("Action:", [
    "Browse frontier models",
    "Enter model key manually",
    "Clear override (use default)",
    "Cancel",
  ]);

  if (!action || action === "Cancel") return;

  if (action === "Clear override (use default)") {
    delete agentSettings[agent.name];
    saveAgentSettings(ctx, agentSettings);
    ctx.ui.notify(`Cleared override for ${agent.name}`, "success");
    return;
  }

  if (action === "Enter model key manually") {
    const modelKey = await ctx.ui.input("Enter model key (provider/model-id):");
    if (!modelKey) return;

    agentSettings[agent.name] = { model: modelKey };
    saveAgentSettings(ctx, agentSettings);
    ctx.ui.notify(`Set ${agent.name} → ${modelKey}`, "success");
    return;
  }

  if (action === "Browse frontier models") {
    await browseFrontierModels(ctx, agent.name, agentSettings);
  }
}

async function browseFrontierModels(
  ctx: ExtensionCommandContext,
  agentName: string,
  agentSettings: AgentSettings,
): Promise<void> {
  // Ask for filters
  const filterAction = await ctx.ui.select("Filter by:", [
    "Show all frontier models",
    "Reasoning models only",
    "Tool-capable models only",
    "Vision models only",
    "Custom filters",
  ]);

  if (!filterAction) return;

  let filters: any = {};
  if (filterAction === "Reasoning models only") filters.reasoning = true;
  if (filterAction === "Tool-capable models only") filters.tools = true;
  if (filterAction === "Vision models only") filters.vision = true;

  if (filterAction === "Custom filters") {
    const capabilities = await ctx.ui.select(
      "Select capabilities (comma-separated):",
      ["reasoning", "tools", "vision", "openWeights"],
    );
    if (capabilities) {
      const caps = capabilities.split(",").map((s) => s.trim());
      if (caps.includes("reasoning")) filters.reasoning = true;
      if (caps.includes("tools")) filters.tools = true;
      if (caps.includes("vision")) filters.vision = true;
      if (caps.includes("openWeights")) filters.openWeights = true;
    }

    const minContext = await ctx.ui.input("Minimum context window (tokens, e.g., 200000):");
    if (minContext) filters.minContext = parseInt(minContext, 10);

    const maxCost = await ctx.ui.input("Maximum input cost ($/1M tokens):");
    if (maxCost) filters.maxInputCost = parseFloat(maxCost);
  }

  const models = filterFrontierModels(filters);

  if (models.length === 0) {
    ctx.ui.notify("No models match your filters", "warning");
    return;
  }

  // Show model list
  const modelChoices = models.map((m) => {
    const caps = [];
    if (m.reasoning) caps.push("reasoning");
    if (m.toolCall) caps.push("tools");
    if (m.vision) caps.push("vision");
    if (m.openWeights) caps.push("open");

    return `${m.modelKey.padEnd(40)} ${formatTokens(m.maxInputTokens).padEnd(6)} ${formatCost(m.inputCost, m.outputCost).padEnd(15)} ${caps.join(", ")}`;
  });

  const selected = await ctx.ui.select("Select model:", modelChoices);
  if (!selected) return;

  const selectedIndex = modelChoices.indexOf(selected);
  const model = models[selectedIndex];

  // Resolve to cheapest route
  const availableProviders = getAvailableProviders();
  const resolved = resolveModel(model.modelKey, undefined, availableProviders);

  ctx.ui.notify(
    `Selected: ${model.modelKey}\nProvider: ${resolved?.provider || "direct"}\nCost: ${formatCost(resolved?.inputCost || 0, resolved?.outputCost || 0)}\nContext: ${formatTokens(model.maxInputTokens)}`,
    "info",
  );

  // Ask to confirm
  const confirm = await ctx.ui.confirm(
    "Confirm",
    `Set ${agentName} → ${model.modelKey}?`,
  );

  if (!confirm) return;

  agentSettings[agentName] = { model: model.modelKey };
  saveAgentSettings(ctx, agentSettings);
  ctx.ui.notify(`Set ${agentName} → ${model.modelKey}`, "success");
}
