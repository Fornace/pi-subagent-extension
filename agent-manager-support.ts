/**
 * AgentManager — spawns and manages child pi agents via RPC protocol
 *
 * Each child runs as `pi --mode rpc --no-session` with stdin/stdout JSON lines.
 * Supports: steer, interrupt, wait, status, and shared workspaces.
 */

import { type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { Workspace } from "./workspace.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentSpawnConfig {
  agentName: string;
  model?: string;
  systemPrompt?: string;
  task: string;
  cwd: string;
  workspaceId?: string;
  workspace?: Workspace;
  signal?: AbortSignal;
  tools?: string[];
  onUpdate?: (event: AgentEvent) => void;
}

export type AgentState = "spawning" | "running" | "idle" | "completed" | "failed" | "aborted";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  contextTokens: number;
}

export interface ManagedAgent {
  handle: string;
  agentName: string;
  model?: string;
  task: string;
  status: AgentState;
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  messages: Message[];
  usage: UsageStats;
  startTime: number;
  endTime?: number;
  finalOutput?: string;
  error?: string;
  workspaceId?: string;
  workspace?: Workspace;
  completionPromise: Promise<void>;
  _resolveCompletion: () => void;
  _rejectCompletion: (err: Error) => void;
  _stdoutBuffer: string;
  _stderrBuffer: string;
}

export interface AgentEvent {
  type: string;
  handle: string;
  data?: any;
}

export interface AgentStatusInfo {
  handle: string;
  agentName: string;
  model?: string;
  status: AgentState;
  task: string;
  elapsedMs: number;
  usage: UsageStats;
  workspaceId?: string;
  finalOutput?: string;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let handleCounter = 0;

export function generateHandle(agentName: string): string {
  return `${agentName}-${++handleCounter}`;
}

export function getPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: [] };
  }
  return { command: "pi", args: [] };
}

export function getFinalOutput(messages: Message[]): string {
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

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
}

export function rpcSend(stdin: NodeJS.WritableStream, cmd: Record<string, unknown>): void {
  stdin.write(JSON.stringify(cmd) + "\n");
}

/** Attach a JSONL reader to a stream. Splits on \n only (protocol-compliant). */
export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onEnd?: () => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line) onLine(line);
    }
    onEnd?.();
  });
}
