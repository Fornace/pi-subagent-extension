/** Tested minimum for the session-level agent_settled RPC contract. */
export function assertManagedRuntime(version: string): void {
  // Pi package versions are machine-generated semver, not provider prose.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[^ ]+)?$/.exec(version);
  if (match) {
    const [major, minor, patch] = match.slice(1).map(Number);
    if (major > 0 || minor > 84 || (minor === 84 && patch >= 4)) return;
  }
  throw new Error("Managed RPC agents require stable Pi 0.84.4 or newer (agent_settled support); update Pi before spawning workers.");
}
