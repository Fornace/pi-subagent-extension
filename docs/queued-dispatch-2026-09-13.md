# Queued child dispatch

Source verification, 2026-09-13. Unified release and installed adoption remain pending.

Managed and batch dispatch share a FIFO with four active permits. `agent_spawn`
returns a queued handle immediately. Waiting assignments create no process and
make no provider request. Released capacity dispatches the oldest waiting task.
Owner admission pauses preserve that queue and clearing the pause resumes it.
A failed launch releases its permit without failing independent assignments.
Queued instructions can be updated, cancelled or inspected through their handle.
Idle follow-up rounds use the same queue. Ordinary idle processes still retire
after 60 seconds and their session files can be resumed.

The manager and process launcher are separate modules. Temporary prompt files are
created only at dispatch, with mode600. Process exit before prompt settlement is
an error even when its exit code is zero. Idle reap timers check the current state
and replace earlier timers, so an old idle timer cannot terminate a new round.
The sidebar shows queued assignments separately from active model work.

## Evidence

- Existing `npm test` passed.
- Strict-null TypeScript check passed for manager, launch, admission, activity,
  owner policy and managed-spawn paths.
- Direct FIFO exercise passed nine assignments, cancellation, owner pause/resume,
  four-permit occupancy, failure release and independent continuation. No child
  process or provider request was created by this exercise.
- Actual Pi0.85.1 local transport fixture passed four active children plus a fifth
  queued assignment, settled release, prompt-result deduplication, queued follow-up,
  real60-second idle retirement, durable session resume and guardless rejection.
  Seven local fixture requests, zero upstream requests.
- Sidebar's existing82 checks passed.

## Remaining

Queue and manager registry restoration after parent replacement is not implemented.
Result-change notification, goal yielding and provider recovery remain separate work.
A broader full-entry-point TypeScript check exposed existing tool-result typing
errors in control, wait, workspace and batch modules. Inspection of installed
pi-agent-core also confirmed that returning `isError` from execute does not signal
a tool error: execute failures must throw. These failures are recorded and must be
fixed on the original paths before release. No verification gate was skipped.
