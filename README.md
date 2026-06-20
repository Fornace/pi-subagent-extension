# Subagent Extension (local)

Delegate tasks to specialized subagents with isolated context windows.

## Current local roster

Only these user agents are active in `~/.pi/agent/agents/`:

| Agent | Purpose | Model |
|-------|---------|-------|
| `scout` | Fast codebase recon | `qwen-flash` → `alibaba-cloud/qwen-flash` |
| `planner` | Plans + durable task/workflow state | `gemini-3.1-pro` → `google/gemini-3.1-pro-preview` |
| `builder` | Implementation, unrestricted/default tools | `qwen-max` → `alibaba-cloud/qwen-max` |
| `critic` | Adversarial review/test analysis | `deepseek-v4-pro` → `alibaba-cloud/deepseek-v4-pro` |
| `operator` | Server/deploy/debug ops | `qwen-max` → `alibaba-cloud/qwen-max` |
| `researcher` | Deep research — web, papers, shell-driven deep-research | `gemini-3.1-pro` → `google/gemini-3.1-pro-preview` |

`worker`, `reviewer`, and `writer` remain intentionally disabled (pruned 2026-06-12 to avoid agent sprawl and stale Claude defaults). `researcher` was **reinstated 2026-06-20**: it is the only roster agent with web (`ctx_url_read`) and shell (`ctx_shell`, driving `parallel-cli` deep-research) access. Without it, research tasks were misrouted to `scout` (read-only), which thrashed. The old researcher was stale (raw built-in tools, weak default model); the new one uses compressed `ctx_*` tools, `gemini-3.1-pro`, and the Parallel deep-research workflow.

Model names are resolved against Pi's registered/available provider registry first. Aliases like `qwen-max` are preferred over hardcoded dated model IDs. If an agent model cannot be resolved, the child inherits the dispatching agent's current model instead of silently falling back to Claude or another stale default.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── builder.md       # Implementation
│   ├── critic.md        # Adversarial review
│   ├── operator.md      # Server operations
│   └── researcher.md    # Deep research (web + shell + deep-research)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> builder
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # builder -> critic -> builder
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: ctx_read, ctx_grep, ctx_find, ctx_ls
model: qwen-flash
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | qwen-flash | lean-ctx read/search |
| `planner` | Implementation plans | gemini-3.1-pro | lean-ctx read/search + write plans + ctx_task/workflow |
| `builder` | Implementation | qwen-max | unrestricted/default tools |
| `critic` | Adversarial review | deepseek-v4-pro | lean-ctx review/impact/test tools |
| `operator` | Server operations | qwen-max | shell/server tools |
| `researcher` | Deep research (web/papers/deep-research) | gemini-3.1-pro | ctx_url_read + ctx_shell + read/write |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → builder |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | builder → critic → builder |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
