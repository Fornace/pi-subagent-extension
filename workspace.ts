/**
 * Workspace — shared state directory for inter-agent communication
 *
 * Each workspace is a temp directory where agents can read/write files.
 * Parent orchestrator creates workspaces and injects the path into child prompts.
 * Children use standard read/write/bash tools to access workspace files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class Workspace {
  readonly id: string;
  readonly path: string;
  private statePath: string;

  constructor(id?: string) {
    this.id = id || `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.path = fs.mkdtempSync(path.join(os.tmpdir(), `pi-workspace-${this.id}-`));
    this.statePath = path.join(this.path, "state.json");
    fs.writeFileSync(this.statePath, "{}", "utf-8");
  }

  /** Get the full path to a file within the workspace. */
  filePath(name: string): string {
    return path.join(this.path, name);
  }

  // ─── State (JSON key-value) ─────────────────────────────────────────────

  /** Read the entire state object. */
  readState(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
    } catch {
      return {};
    }
  }

  /** Read a specific key from state. */
  getKey(key: string): unknown {
    return this.readState()[key];
  }

  /** Write a key-value pair to state. */
  setKey(key: string, value: unknown): void {
    const state = this.readState();
    state[key] = value;
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /** Delete a key from state. */
  deleteKey(key: string): boolean {
    const state = this.readState();
    if (!(key in state)) return false;
    delete state[key];
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf-8");
    return true;
  }

  /** List all keys in state. */
  listKeys(): string[] {
    return Object.keys(this.readState());
  }

  // ─── Files (arbitrary files in workspace dir) ──────────────────────────

  /** Write a file to the workspace. */
  writeFile(name: string, content: string): string {
    const filePath = path.join(this.path, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** Read a file from the workspace. */
  readFile(name: string): string | null {
    const filePath = path.join(this.path, name);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /** List all files in the workspace (excluding state.json). */
  listFiles(): string[] {
    try {
      return fs.readdirSync(this.path).filter((f) => f !== "state.json");
    } catch {
      return [];
    }
  }

  /** Check if a file exists in the workspace. */
  hasFile(name: string): boolean {
    return fs.existsSync(path.join(this.path, name));
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /** Remove the workspace directory entirely. */
  destroy(): void {
    try {
      fs.rmSync(this.path, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  /** Get a summary of workspace contents for display. */
  summary(): string {
    const keys = this.listKeys();
    const files = this.listFiles();
    const parts: string[] = [`Workspace: ${this.path}`];
    if (keys.length > 0) parts.push(`State keys: ${keys.join(", ")}`);
    if (files.length > 0) parts.push(`Files: ${files.join(", ")}`);
    return parts.join("\n");
  }
}
