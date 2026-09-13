---
name: fornace-model-routing
description: "Route work among the four standard Fornace tiers, reserve Astra for explicit user requests, and verify serving identity and spending boundaries."
---

# Fornace model routing

Use the cheapest capable standard route: Flash, Fast, Reasoning or Max.
Owner correction, 2026-09-13: Astra requires an explicit user request, including
for difficult work, pre-execution review, technical recovery and quota failover.
Use the dedicated vision, image and other media routes when the task needs them.
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
| `mantice/fornace-astra` | Explicit user requests for Astra only. |

Automatic recovery stays within the four standard routes and the authorized
spending policy. Preserve a user's fixed model selection when one is specified.

## Mandatory review before consequential execution

Review the actual execution path before delicate, expensive or very long-running
work. Use `fornace-max` for the consequential review, unless the user explicitly
requests Astra. The 2026-09-13 routing correction supersedes the earlier automatic
Astra selection. Bind review to the code that will actually execute, including
main-session scripts and changes after a successful pilot.

1. Give the reviewer the exact executable source revision, launch command,
   configuration, input sizes, environment/resource limits, expected runtime and
   cost, and prior findings. Read the actual execution path and dependencies,
   including output writing and finalization; a plan or progress log is insufficient.
2. Debug correctness and complete-job feasibility before spending on the full run.
   Inspect peak memory and disk, temporary copies and finalization allocations,
   chunk boundaries, durable outputs, checkpoint/resume behavior, failure handling
   and observable ownership/progress. Logging alone does not establish recoverability.
3. Fix discovered defects in the original path. Verify the applicable small
   end-to-end path, including saving, reloading and interruption/resume where
   relevant. Check full-scale resource arithmetic separately; a successful batch
   does not prove the whole job can finish. Use direct manual probes unless tests
   are explicitly requested.
4. Record a concise review bound to the code/configuration actually being launched,
   with findings, fixes, verification and unresolved constraints. Resolve constraints
   that affect execution before launch. Re-review affected behavior after material
   changes; review of an older implementation does not cover a replacement script.
5. If a standard route is unavailable, use another capable standard route within
   policy, preserving its failure diagnosis. Fixed user model requests and actual
   spending or access boundaries remain binding.

This is a technical execution requirement, not a new human-approval workflow.
Before declaring an approval blocker, read the original user messages and separate
user-imposed limits from an assistant-selected pilot envelope. An unanswered
assistant permission question does not revoke existing user delegation. When that
delegation covers a new bounded attempt, record the operator's decision explicitly,
preserve prior clocks and cumulative liabilities, and never describe it as fresh
human consent. This does not expand an actual user spending limit or authorize
unbounded retries.
Use ordinary routes for implementation and review. Consequential review never
implies permission to select Astra automatically.

## Escalation contract

1. For ordinary work outside the mandatory pre-execution rule, begin with the
   appropriate ordinary route. Do not route every task to Max.
2. Reuse existing code, findings, receipts, reproductions and attempted fixes.
3. When Max or another lower route reports a wall, preserve the exact failing path.
4. Continue diagnosis on the appropriate standard route. When the user explicitly
   requests Astra, give it the original objective, exact reproducer, observed
   errors, relevant files, attempted fixes, resource limits and prior evidence.
5. An explicit Astra request may use `astra-debugger` for review or the named
   `builder` with `model: mantice/fornace-astra` for scoped implementation.
6. Return the repaired path to an ordinary route for bounded implementation when
   the remaining work is mechanical.

Review a proposed discard against the actual failing path and plausible
implementation, parser, routing, truncation, tool-execution or evidence defects.
Use Max by default. Direct execution and measurements remain the evidence.

## Paid execution and emergency pauses

- Keep the owner's goal budget metric intact, but account for financial exposure
  separately: billable cached tokens, children and paid route changes can cost
  money even when the goal tracker excludes them. Unlimited goal tokens do not
  disable a distinct financial or context emergency brake.
- Zero recorded cost is not proof a provider is free. Verify current upstream
  pricing and the gateway's deployment prices before unattended paid work.
- Use one bounded assignment and collect existing results. Count active workers
  separately from retained idle processes. Process age and a 600-second wait
  do not prove a busy loop; verify request attribution and actual progress.
- Parent compaction does not compact child sessions. Verify child guard adoption
  and use the shared harness pause rather than relying only on prompt caps.
- A financial or compaction brake is not a retryable provider failure. Do not
  evade it through another model, token, child, tool or goal replacement.
- On a brake, preserve goal and artifacts and leave a repair note containing
  session/worker identity, last verified milestone, unfinished operations,
  reason for pause and the exact human recovery condition. Installation and
  reload must be verified before resuming; no unattended restart loops.

## Dispatch rules

- Use the owner's declared budget metric. For a Pi goal budget, count only the goal tracker's input/output by default; do not add cache, worker, maintenance or historical-tranche totals unless the owner explicitly includes them. A later unlimited instruction supersedes earlier finite limits. Verify the returned tracker configuration before claiming unlimited; writing that word in an objective does not remove a numeric `tokenBudget`. When a user explicitly chooses whole-workflow accounting instead, reconcile the agreed channels without silently resetting them. A child-prompt cap is advisory, not enforcement.

- Prefer named roles. Use `quick` for Flash, `scout` for Fast, `planner` and
  `researcher` for Reasoning, `builder`, `critic` and `operator` for Max, and
  `astra-debugger` for Astra.
- Override a named role with Astra only after an explicit user request.
- Never pass an empty `model` string. Omit the field to use the named role.
- An explicit model request must resolve exactly. Unknown explicit models fail;
  they must not inherit the parent model.
- Verify the spawn receipt before relying on the child. Stop a route mismatch.
- Preserve child artifacts. Steer an active or idle child rather than commissioning
  duplicate work merely to collect output.
- When a source seal unblocks another worker, collect and relay that checkpoint
  before waiting for the producer's later qualification work. A commit, workspace
  note or sibling's assumed ownership is not a delivered assignment. The parent
  explicitly steers the receiving worker with the revision, paths and remaining scope.
- When splitting process ownership from journal/publication repairs, agree the
  typed cleanup-evidence interface before parallel edits. Publication consumes
  proved accounting; empty output or descendant lists are insufficient. A host
  build does not compile target-specific branches: qualify the actual production
  target before treating platform repairs as compiled.
- For journal or retained-state repairs, trace every actual writer outcome into
  its reader, including committed failures and unresolved cleanup. Verify exact
  values, not only nullable shapes. Read-only counterexamples should include
  changed nonzero exit codes, changed signal numbers and genuine writer failure
  records. A validator that rejects honest failed records has not preserved
  finality merely because its success fixtures pass. Keep the admitted file
  descriptor through metadata inspection and hashing rather than reopening its
  pathname. Trace runtime behavior beneath launch wrappers as well: Rust 1.97
  `CommandExt::exec` resets SIGPIPE to default unless `-Zon-broken-pipe` is used.
  A call site with no explicit signal reset does not prove inherited disposition.
  Exercise the actual serializer and strict reader together. A flattened event
  can duplicate an envelope key; Python's default JSON dict parser may hide that
  collision while Serde rejects the emitted bytes. Keep failed bytes unchanged
  and use duplicate-key-aware forensic parsing rather than normalizing them.
  For public projections, follow private text through every serialized alias,
  including terminal reasons and typed errors. A redacted success report does
  not prove its Serde type-error path hides rejected input values; exercise that
  actual CLI path with a synthetic private sentinel. Inspect nested argument
  grammars as well: a separate argv element can still be an option, or an SSH
  `-o` value can expand into multiple paths. Verify output-file admission
  independently from input-file admission, including FIFO refusal and modes.
  Retain filesystem timestamps as seconds plus nanoseconds when the source
  range exceeds an epoch-nanoseconds i64. Before/after fd metadata agreement
  is a stability observation, not a proof that concurrent writes were absent.
  Manual drivers must preserve the actual method-binding and producer/consumer
  path. Replacing a static method with a bound recorder that passes `self`
  explicitly can hide a missing-argument defect. Mixin methods resolve free names
  in their defining module, and quoted shell heredocs need explicit value passing.
  Exercise the original launch block and final receipt consumer, not replicas.
  An unexpectedly accepted negative case must fail the driver, not merely print
  a warning before an unconditional PASS. Substitute external I/O rather
  than methods under verification, and retain driver plus loaded-source hashes.
  A tiny deadline is not proof that a probe cannot reach the network. Explicitly
  substitute or exclude the transport and inspect the typed inner failure.
  Mark transport-call entry before awaiting a response; a failed response cannot
  turn an attempted exchange into a zero-call claim. A current source hash match
  does not establish which bytes an earlier executable loaded.
  Apply total-call clocks before admission, not only before subprocess launch.
  A pre-read size check needs a during-read byte bound, and FIFO refusal needs
  nonblocking open before fstat. Keep bounded raw diagnostics on failure paths
  as well as successful receipts; output hashes alone cannot reproduce a parse.
  Exercise narrowly reproduced cleanup failures through the actual functions
  with external primitives substituted. A collected exception needs an explicit
  failure outcome, never a `None` later unpacked as success. Preserve all cleanup
  errors and the first control-flow exception until after capture assembly.
  Before adding parent-death wrappers, check whether the nested controller can
  run inside its existing owner so that client handles and cleanup survive the
  same interruption boundary. Exercise interruption while the nested client is
  still live; a synchronous fake that finishes it before wait cannot prove this.
  Keep these reproductions bounded; do not grow a mock suite when the owner
  requested direct manual verification.
- If a lower model loses decisive context, provide the compact artifact bundle.
  Do not ask Astra to rediscover everything from a long transcript.

## Examples

Routine implementation:

```json
{"agent":"builder","task":"Implement the exact interface and verify it."}
```

Explicitly user-requested Astra implementation:

```json
{"agent":"builder","model":"mantice/fornace-astra","task":"Debug this reproduced numerical failure using the attached evidence."}
```

Explicitly user-requested Astra review:

```json
{"agent":"astra-debugger","task":"Review the exact failing path and steer the repair. Preserve prior work."}
```
