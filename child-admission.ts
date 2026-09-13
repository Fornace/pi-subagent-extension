/** One FIFO for batch and managed work. Only dispatched work owns a permit. */
export const MAX_ACTIVE_CHILDREN = 4;
const active = new Set<string>();
const pending = new Map<string, { start: () => void; failed: (error: unknown) => void }>();
let blocked: string | undefined;
let scheduled = false;

export function setAdmissionBlock(reason?: string): void {
  blocked = reason;
  schedule();
}
export function acquire(key: string): void {
  if (blocked) throw new Error(`Child admission paused: ${blocked}`);
  if (active.has(key)) return;
  if (active.size >= MAX_ACTIVE_CHILDREN) throw new Error("Child capacity requires queued admission");
  active.add(key);
}
export function release(key: string): void {
  active.delete(key);
  schedule();
}
export function activeCount(): number { return active.size; }
export function queuedCount(): number { return pending.size; }
export function admissionReason(): string | undefined { return blocked; }

export function queueChild(key: string, start: () => void, failed: (error: unknown) => void): () => void {
  if (pending.has(key) || active.has(key)) throw new Error(`Duplicate child admission: ${key}`);
  pending.set(key, { start, failed });
  schedule();
  return () => { pending.delete(key); };
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    while (!blocked && active.size < MAX_ACTIVE_CHILDREN && pending.size) {
      const [key, work] = pending.entries().next().value!;
      pending.delete(key);
      active.add(key);
      try { work.start(); }
      catch (error) { release(key); work.failed(error); }
    }
  });
}
