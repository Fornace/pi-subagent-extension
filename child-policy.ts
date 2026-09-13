import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export const LIFETIME_POLICY = "subagent-lifetime-policy";
const DISPATCH_POLICY = "subagent-dispatch-policy";
export const DEFAULT_CHILD_TOKENS = 8_000_000;
interface Policy { version: 1; tokenLimit: number; maxDepth: number; depth: number }
function integer(value: unknown, min: number, max: number, label: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid child ${label}`);
  return n;
}
function inherited(): Policy {
  return {
    version: 1,
    depth: integer(process.env.PI_SUBAGENT_DEPTH ?? (process.env.PI_SUBAGENT_OWNER_PID ? "1" : "0"), 0, 3, "depth"),
    maxDepth: integer(process.env.PI_SUBAGENT_MAX_DEPTH ?? "1", 1, 3, "maximum depth"),
    tokenLimit: integer(process.env.PI_SUBAGENT_LIFETIME_TOKENS ?? String(DEFAULT_CHILD_TOKENS), 1, 10_000_000, "token allowance"),
  };
}
let policy: Policy | undefined;
let policyFault: string | undefined;
export function dispatchPolicy(): Policy {
  if (policyFault) throw new Error(policyFault);
  return policy ?? inherited();
}
export function admitChild(): Policy {
  const current = dispatchPolicy();
  if (current.depth >= current.maxDepth) throw new Error(`Child nesting blocked at depth ${current.depth}. Root human /subagent-policy sets bounded future-child policy.`);
  return { ...current, depth: current.depth + 1 };
}
export function registerDispatchPolicy(pi: ExtensionAPI): void {
  const restore = (ctx: ExtensionContext) => {
    policyFault = "Child dispatch policy restoration failed. Inspect the extension error before dispatch.";
    policy = inherited();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === LIFETIME_POLICY) {
        const data = entry.data as Partial<Policy>;
        if (data.version !== 1) throw new Error("Invalid child lifetime policy version");
        policy = { version: 1,
          depth: integer(data.depth ?? 1, 1, 3, "durable depth"),
          maxDepth: integer(data.maxDepth ?? 1, 1, 3, "durable maximum depth"),
          tokenLimit: integer(data.tokenLimit, 1, 10_000_000, "durable token allowance"),
        };
      }
      if (entry.customType === DISPATCH_POLICY && policy.depth === 0) {
        const data = entry.data as Partial<Policy>;
        if (data.version !== 1) throw new Error("Invalid child dispatch policy version");
        policy = { ...policy, maxDepth: integer(data.maxDepth, 1, 3, "maximum depth"), tokenLimit: integer(data.tokenLimit, 1, 10_000_000, "token allowance") };
      }
    }
    policyFault = undefined;
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.registerCommand("subagent-policy", {
    description: "Inspect policy, or explicitly set future children: <maximum-depth 1..3> <tokens 1..10000000>",
    async handler(args, ctx) {
      const current = dispatchPolicy();
      if (args.trim() && args.trim() !== "status") {
        if (current.depth !== 0) throw new Error("Only the root human owner can raise child dispatch policy");
        if (!ctx.isIdle()) throw new Error("Wait for root owner idle before changing child policy");
        const parts = args.trim().split(/\s+/);
        if (parts.length !== 2) throw new Error("Use /subagent-policy <maximum-depth> <child-tokens>");
        const next = { ...current, maxDepth: integer(parts[0], 1, 3, "maximum depth"), tokenLimit: integer(parts[1], 1, 10_000_000, "token allowance") };
        if (!ctx.hasUI || !await ctx.ui.confirm("Child dispatch policy", `Future children: ${next.tokenLimit} tokens each, maximum depth ${next.maxDepth}. Existing allowances remain fixed.`)) {
          ctx.ui.notify("Child policy unchanged", "info"); return;
        }
        pi.appendEntry(DISPATCH_POLICY, next);
        policy = next;
      }
      ctx.ui.notify(JSON.stringify(dispatchPolicy()), "info");
    },
  });
}
