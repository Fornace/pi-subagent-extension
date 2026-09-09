export const FORNACE_ROUTING_GUIDELINES = [
  "For delegated work, choose the least expensive capable route: quick uses fornace-flash for mechanical work; scout uses fornace-fast for focused reconnaissance; planner and researcher use fornace-reasoning for synthesis; builder, critic, and operator use fornace-max for substantial work.",
  "Reserve astra-debugger or builder with model mantice/fornace-astra for higher mathematics, deep debugging, steering a hard recovery, or reviewing a discard after a lower model reports a wall.",
  "Before an Astra escalation, pass the exact objective, reproduction, errors, relevant files, prior findings, attempted fixes, and resource limits so prior work is reused instead of rediscovered.",
  "Verify the spawned model route and stop a mismatch. Never silently replace an explicit model request or treat a routing alias as a fixed backend identity.",
];

export const FORNACE_MODEL_IDS = [
  "mantice/fornace-flash",
  "mantice/fornace-fast",
  "mantice/fornace-reasoning",
  "mantice/fornace-max",
  "mantice/fornace-astra",
] as const;
