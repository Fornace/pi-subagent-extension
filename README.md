# Subagent Extension (local)

Delegate tasks to specialized subagents with isolated context windows.

## Current Fornace roster

The packaged default roster uses Mantice routing aliases by task difficulty:

| Agent | Purpose | Model | Thinking |
|-------|---------|-------|----------|
| `quick` | Mechanical edits, extraction, formatting and simple checks | `mantice/fornace-flash` | low |
| `scout` | Focused codebase reconnaissance | `mantice/fornace-fast` | low |
| `planner` | Plans and difficult synthesis | `mantice/fornace-reasoning` | high |
| `researcher` | Web and source synthesis | `mantice/fornace-reasoning` | high |
| `builder` | Substantial implementation and integration | `mantice/fornace-max` | high |
| `critic` | Adversarial review and ordinary debugging | `mantice/fornace-max` | high |
| `operator` | Server, deployment and operational work | `mantice/fornace-max` | high |
| `astra-debugger` | Explicitly requested Astra work | `mantice/fornace-astra` | max |

Load the packaged `fornace-model-routing` skill before choosing a delegation
route. The standard routes are Flash, Fast, Reasoning and Max. Astra requires an
explicit user request, including for hard debugging, mathematics and recovery.
Vision, image and other media work uses its matching specialized route.

Model aliases are resolved against Pi's registered provider catalog. An absent or
`default` model inherits the dispatching agent. An explicit unresolvable model
fails before spawning; it never inherits silently. Spawn/status receipts report
the requested routing alias. Provider response attribution, when available, is a
separate runtime identity and routing aliases must not be described as fixed backends.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Batch cancellation stops its subprocesses; cancelling
  `agent_wait` cancels only observation and leaves the managed child running.

Managed RPC waits use Pi's `agent_settled` event, not process exit or the
intermediate `agent_end` event. The tested runtime baseline is Pi 0.84.4;
older runtimes are not supported by this lifecycle contract. A settled worker
remains reusable for follow-ups. Prompt rejection is reported without replay.

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── quick.md         # Mechanical work on fornace-flash
│   ├── scout.md         # Focused recon on fornace-fast
│   ├── planner.md       # Planning on fornace-reasoning
│   ├── builder.md       # Implementation on fornace-max
│   ├── critic.md        # Review on fornace-max
│   ├── operator.md      # Operations on fornace-max
│   ├── researcher.md    # Research on fornace-reasoning
│   └── astra-debugger.md # Explicitly requested Astra review
├── skills/
│   └── fornace-model-routing/SKILL.md # Routing and escalation contract
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> builder
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # builder -> critic -> builder
```

## Installation

### Pi package

```bash
pi install npm:pi-subagent-extension
# or from git
pi install git:github.com/Fornace/pi-subagent-extension
```

### Local (development)

Sync the repo into the extensions directory:

```bash
rsync -a --delete --exclude node_modules --exclude .git --exclude graphify-out \
  ./ ~/.pi/agent/extensions/subagent/
cd ~/.pi/agent/extensions/subagent && npm install
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
Use `quick` for a small mechanical task
Use `builder` for substantial implementation
Use `astra-debugger` only when the user explicitly requests Astra
Use `builder` with model `mantice/fornace-astra` only for an explicit Astra implementation request
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
tools: read, grep, find, ls
model: mantice/fornace-fast
thinking: low
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
| `quick` | Mechanical work | fornace-flash | focused local tools |
| `scout` | Focused codebase recon | fornace-fast | read/search |
| `planner` | Implementation plans | fornace-reasoning | read/search + planning artifacts |
| `builder` | Substantial implementation | fornace-max | unrestricted/default tools |
| `critic` | Adversarial review | fornace-max | read-only review tools |
| `operator` | Server operations | fornace-max | shell/server tools |
| `researcher` | Source and web synthesis | fornace-reasoning | web + shell + read/write |
| `astra-debugger` | Explicitly requested Astra work | fornace-astra | read-only evidence review |

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
