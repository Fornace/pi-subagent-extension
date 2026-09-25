# Changelog

## 1.2.0 (2026-09-26)

- Emit durable child usage receipts and charge their input plus output to the
  owner goal exactly once, including after restart reconciliation.
- Treat an exhausted worker token tranche as a resumable `yielded` handoff.
  Background workers wake the still-active parent once; blocking batch and chain
  tools return the handoff directly. Sibling admission remains open.
- Keep guard-integrity and ownership failures as dispatch-blocking failures.
- Drop the packaged `fornace-model-routing` skill. It is owned by the
  user-level skills directory (`~/.pi/agent/skills/`, distributed by pi-setup)
  and wins every name collision anyway; the packaged copy had already drifted
  stale and triggered a `[Skill conflicts]` warning at every startup.

## 1.1.0

- Add task-difficulty routing across `fornace-flash`, `fornace-fast`,
  `fornace-reasoning`, `fornace-max` and opt-in `fornace-astra`.
- Add `quick` and `astra-debugger` roles plus the packaged
  `fornace-model-routing` skill.
- Pass named-role thinking levels to both batch and managed children.
- Apply user agent-model settings to batch delegation.
- Reject unresolved explicit model requests instead of inheriting the parent.

## 1.0.3

- Deliver explicit follow-ups to idle managed workers.
