# Managed RPC lifecycle verification — 2026-09-06

Managed waits observe session-level `agent_settled`, not process exit or
intermediate `agent_end`. Tested runtime: Pi0.84.4, Node26.0.0. Host package
version is checked before spawning; custom child launchers still need separate
version verification. Stable Pi0.84.4 or newer is the supported baseline, not
a claim that every future release is verified.

Cancelling `agent_wait` cancels observation only. It does not interrupt the
child, replay prompts, change providers or override refusals. Settled errors
remain errors; successful idle workers remain reusable.

Commands carry unique request IDs. Unknown, duplicate and stale responses are
ignored; a rejected queued command cannot declare active accepted work idle.
Outstanding acknowledgements are capped256. Idle follow-up fences immediate
waits and clears previous output. Process-exit cleanup remains separate.

Real process exercise: isolated agent directory/cwd, dummy credential and
gated loopback mock; same Pi child completed three prompts. Third parent wait
was cancelled while the mock held its response; child survived and a later wait
received the result after gate release.

```json
{"result":"passed","provider_calls":3,"paid_provider_calls":0,"same_child_prompts":3,"wait_cancelled_child_preserved":true,"settled_events":3}
```

Temporary probe SHA256:
208f4172b358a6f613c2d3e6eddb68981c2c4deaf3e2e1db6171c1edab76701e
Probe, generated configuration and owned processes cleaned after execution.
No retained test additions. Inline probes also covered two-result event order,
retry/post-end gaps, timeout, cancellation, rejected prompt batches, stale and
duplicate acknowledgements, and settled success/error tool contracts.
Existing npm test passes. Extension registration loads eight tools, /agents
and shutdown hook. Pack dry-run includes the split modules. These checks do not
cover every batch execution/rendering branch or multiweek operation.

Official current contract and installed source reviewed:
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
Installed agent-session.js emits agent_settled after session continuations;
rpc-mode.js emits prompt acceptance/rejection separately from run completion.

Source publication is not runtime installation. Reload triggers manager cleanup
and can interrupt managed children; never reload an active owner to install this
fix. Collect worker output/checkpoint first and choose an idle session boundary.
