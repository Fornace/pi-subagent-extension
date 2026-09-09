---
name: fornace-model-routing
description: Route delegated work among fornace-flash, fornace-fast, fornace-reasoning, fornace-max, and fornace-astra. Load before choosing a subagent model, escalating a hard debugging wall, delegating advanced mathematics, or reviewing a proposed discard after a lower model stalled.
---

# Fornace model routing

Use the cheapest model that can finish the task while preserving prior work.
Model aliases are routing contracts. Record the requested alias and the returned
model identity when the provider exposes it; never claim the alias is a fixed
backend model.

## Routes

| Model | Use for |
|---|---|
| `mantice/fornace-flash` | Small mechanical edits, extraction, classification, formatting, bounded lookups, simple source checks and cheap parallel lanes. Flash remains capable; do not treat it as disposable. |
| `mantice/fornace-fast` | Focused repository reconnaissance, straightforward analysis, small implementation, routine verification and fast iteration with moderate context. |
| `mantice/fornace-reasoning` | Planning, research synthesis, architecture comparison and difficult reasoning that needs depth without extreme mathematical or debugging demands. |
| `mantice/fornace-max` | Substantial implementation, integration, code review, operations and ordinary debugging. This is the default builder for consequential work. |
| `mantice/fornace-astra` | Advanced mathematics, deep debugging, steering a hard technical recovery, lateral-thinking review and adjudication when lower models appear to hit a wall or propose discarding prior work. |

Astra leads by a large margin on deep debugging and higher mathematics. Use it
when those capabilities affect the result. Do not spend Astra on routine reading,
formatting, ordinary implementation or checks that Flash, Fast, Reasoning or Max
can complete.

## Escalation contract

1. Begin with the appropriate ordinary route. Do not route every task to Max.
2. Reuse existing code, findings, receipts, reproductions and attempted fixes.
3. When Max or another lower route reports a wall, preserve the exact failing path.
4. Give Astra the original objective, exact reproducer, observed errors, relevant
   files, attempted fixes, resource limits and prior evidence. Ask it to debug and
   steer, not restart broad research.
5. Astra may review directly or run the named `builder` role with
   `model: mantice/fornace-astra` when hard implementation needs both deep
   debugging and file edits.
6. Return the repaired path to an ordinary route for bounded implementation when
   the remaining work is mechanical.

A proposed discard after a hard failure requires Astra review when a plausible
implementation, parser, routing, truncation, tool-execution or evidence defect
could explain it. Astra review does not make a hypothesis true; direct execution
and relevant measurements remain evidence.

## Dispatch rules

- Prefer named roles. Use `quick` for Flash, `scout` for Fast, `planner` and
  `researcher` for Reasoning, `builder`, `critic` and `operator` for Max, and
  `astra-debugger` for Astra.
- Override a named `builder` with Astra only for the scoped hard implementation.
- Never pass an empty `model` string. Omit the field to use the named role.
- An explicit model request must resolve exactly. Unknown explicit models fail;
  they must not inherit the parent model.
- Verify the spawn receipt before relying on the child. Stop a route mismatch.
- Preserve child artifacts. Steer an active or idle child rather than commissioning
  duplicate work merely to collect output.
- If a lower model loses decisive context, provide the compact artifact bundle.
  Do not ask Astra to rediscover everything from a long transcript.

## Examples

Routine implementation:

```json
{"agent":"builder","task":"Implement the exact interface and verify it."}
```

Higher mathematics or deep-debug implementation:

```json
{"agent":"builder","model":"mantice/fornace-astra","task":"Debug this reproduced numerical failure using the attached evidence."}
```

Read-only hard-failure review:

```json
{"agent":"astra-debugger","task":"Review the exact failing path and steer the repair. Preserve prior work."}
```
