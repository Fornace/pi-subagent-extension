export const FORNACE_ROUTING_GUIDELINES = [
  "For delegated work, choose the least expensive capable route: quick uses fornace-flash for mechanical work; scout uses fornace-fast for focused reconnaissance; planner and researcher use fornace-reasoning for synthesis; builder, critic, and operator use fornace-max for substantial work.",
  "Use astra-debugger or a mantice/fornace-astra override only when the user explicitly requests Astra. Routine work, review, hard recovery and quota failover use the four standard routes.",
  "For a user-requested Astra assignment, pass the exact objective, reproduction, errors, relevant files, prior findings, attempted fixes, and resource limits so prior work is reused instead of rediscovered.",
  "Verify the spawned model route and stop a mismatch. Never silently replace an explicit model request or treat a routing alias as a fixed backend identity.",
];

export const FORNACE_MODEL_IDS = [
  "mantice/fornace-flash",
  "mantice/fornace-fast",
  "mantice/fornace-reasoning",
  "mantice/fornace-max",
  "mantice/fornace-astra",
] as const;
