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
import { registerBatch } from "./subagent-tool.ts";
import { registerManagedSpawn } from "./managed-spawn-tool.ts";
import { registerManagedControl } from "./managed-control-tools.ts";
import { registerManagedWait } from "./managed-wait-tool.ts";
import { registerManagedWorkspace } from "./managed-workspace-tool.ts";
export default function (pi: ExtensionAPI) {
registerAgentsCommand(pi);
const agentManager = new AgentManager();
const workspaces = new Map<string, Workspace>();
pi.on("session_shutdown", async () => {
await agentManager.cleanup();
for (const ws of workspaces.values()) ws.destroy();
workspaces.clear();
});
registerBatch(pi);
registerManagedSpawn(pi, agentManager, workspaces);
registerManagedControl(pi, agentManager, workspaces);
registerManagedWait(pi, agentManager, workspaces);
registerManagedWorkspace(pi, agentManager, workspaces);
}
