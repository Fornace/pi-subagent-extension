# Child lifecycle repair, 2026-09-13

Source repair only. Installed ~/.pi/agent/extensions/subagent matched repository source before repair and remains unchanged.

## Controls

Managed and batch children now use the same RPC manager and admission pool. Four active children per owner process. Spawning, running and draining work retains its permit until settlement or process close; settled idle workers release permits. Excess work fails before process creation. Idle processes reap after 60 seconds without removing their durable JSONL or workspace. This timer manages resident processes, not spend classification.

Each child uses --session with a durable path under ~/.pi/agent/subagent-sessions. Status and spawn output include the path; agent_spawn accepts sessionFile for explicit resume. Batch details also include sessionFile. No automatic replay after reaping, failure or interruption. Parent workspaces survive shutdown. Session files and parent tool-result paths provide recovery after the in-memory handle registry is gone.

message_end is the only message accumulation source. Removed agent_end accumulation of repeated decoded objects. Usage was already charged only on message_end, so the old duplicate messages do not prove duplicate billing.

Before sending any prompt, including steering/follow-up while spawning, the child must expose the repaired mantice-guard command through real RPC get_commands. Missing guard fails before paid transport. The guard may be explicitly loaded with PI_SUBAGENT_GUARD_EXTENSION; normal installed discovery remains enabled. Child owner monitoring is always explicitly loaded. This release admits explicit mantice/fornace routes on POSIX only; other routes/platforms fail with an explanation rather than running unguarded.

Child guard pause stops the affected child and persists a parent admission pause. /subagent-guard reset requires an idle owner and ready parent Mantice guard; it does not restart children. Goal automation observes the propagated child pause too. Parent guard compacting/paused blocks new admission.

## Ownership and shutdown

Children start in their own process groups. The parent signals only groups it created, clears RPC queued work before abort, and escalates against exit state rather than ChildProcess.killed. Repeated termination requests share one termination sequence. Failed-but-live children are included in cleanup; live terminal records cannot be pruned.

The child verifies its initial parent and process-group identity. OS PPID monitoring catches reparenting; Node26 process.ppid is a startup value, confirmed by its property descriptor. RPC EOF can exit the child before a timer runs, so a process-exit hook also terminates its owned group. Real SIGKILL-owner verification killed both the child and a known same-group descendant while retaining the session.

Scope: process-group ownership, not a fleet-wide process-name scan. Descendants that deliberately detach into independent groups are outside this mechanism. The four-slot pool is per owner process, not a fleet-wide distributed quota. Adopting across existing live owners remains a separate operation.

## Verification and repair evidence

Real Pi0.85.1 RPC with isolated settings and intercepted fetch: four active children, fifth refused, spawning steer/follow-up fenced, idle count zero active, two prompts on one child without duplicate messages, durable third prompt after actual 60-second idle reap, unguarded child refused before request, cleanup settled. Six fixture requests, zero paid requests.

Owner SIGKILL probe: verified child and same-group descendant exited; durable result remained. First probe exposed that RPC EOF could outrun the timer; fixed in the child exit path and reran successfully. Another probe exposed duplicate SIGTERM during cleanup; made termination idempotent and reran the original path successfully.

Existing npm test passed. Scoped manager/guard TypeScript check passed. Whole-repository ad hoc TypeScript checking exposes pre-existing errors in renderer/tool generics and model registry types; no project typecheck script existed. Graphify AST update ran.

Exact probes/evidence: /tmp/mantice-incident-20260913/{child-manual.mjs,owner-manual.mjs,owner-supervisor.mjs,repair-fixture.ts,child-manual-evidence.json,owner-manual-evidence.json}.
