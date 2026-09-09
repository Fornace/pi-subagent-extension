# Changelog

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
