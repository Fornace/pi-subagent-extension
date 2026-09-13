# Delegation outcomes and explicit routes

Source verification, 2026-09-13, Pi0.85.1. Installed adoption remains pending.

Pi's execute contract returns content and details. An extra `isError` field does
not make execution fail. Invalid requests now throw. Completed batch outcomes use
the supported `tool_result` hook to set error status when a worker fails, retaining
the entire result matrix so the parent can reuse successful work.

A named single-agent override previously appended a second configuration with the
same name. The runner selected the first configuration, bypassing the explicit
override. Dispatch now removes the original same-name record before appending the
resolved configuration. Parameter types come from the actual registered schema.

A wait deadline is a pending observation, not a failed assignment. The worker
continues. Cancellation and unknown handles remain errors. The private eight-task
batch rejection was removed; requested batches execute through shared capacity.

## Verification

- Original `npm test` passed after its existing invalid-model check was aligned
  with the actual Pi exception contract.
- Full `index.ts` TypeScript check with strict null checking passed. Earlier
  settings and tool-result typing failures were repaired, not excluded.
- Real Pi JSON execution with local transport fixtures produced:
  - unknown model: `tool_execution_end.isError=true`, no child process;
  - one successful and one failed batch worker: `isError=true`, both results kept;
  - named builder overridden to Astra: only the child Astra Responses request,
    `isError=false`, successful returned text.
- Those final cases made eight local fixture requests and zero upstream requests.
- A direct wait exercise verified pending timeout, thrown cancellation and thrown
  unknown-handle errors without creating processes or provider requests.

The fixture initially lacked the builder profile, required catalog metadata and
Responses streaming support. Each defect was corrected in that fixture. Final
runs used the intended catalog and transport paths; snapshot use was rejected.
Evidence lives under `/tmp/mantice-incident-20260913/outcome-{unknown,partial,override}`.

Result-change delivery, durable parent registry restoration, automatic provider
recovery and unified package adoption remain separate release requirements.
