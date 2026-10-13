// Grants `jux mcp` tool calls the resources they touch, so calls that touch
// different ones run at the same time and calls that share one take turns.
//
// Agents issue several tool calls in one turn (snap three pages, then diff
// them). Run one at a time, each call waits for every call before it, even
// when they write different snaps. The scheduler replaces that queue with
// keyed reader/writer locks:
//
// - A call declares every lock it needs before it starts, and gets all of
//   them in one step or none. Nothing ever holds one lock while waiting for
//   another, so no set of calls can deadlock, whatever keys they overlap on.
// - Requests that conflict are granted in arrival order. A request that waits
//   blocks every later request it conflicts with, so a writer (or an
//   exclusive call such as run) waiting behind readers is never starved by
//   readers that keep arriving. Requests that do not conflict pass each other.
// - A slot limit caps how many requests of one class (snap) hold at once,
//   independent of keys.

/** What a lock protects. Keys in different projects never conflict. */
export type LockKey =
  /** One snap name: `<project>/.juxtapose/snaps/<name>.webp` and its sidecar. */
  | { kind: 'name'; project: string; name: string }
  /** Every snap `<prefix>-*` and `<prefix>.set.json`: a `urls`+`asPrefix` snap
   *  or a `prefix` diff. */
  | { kind: 'prefix'; project: string; prefix: string }
  /** Anything else, by an opaque string: "run", "crops/<a>~vs~<b>". */
  | { kind: 'key'; project: string; key: string };

export interface Lock {
  key: LockKey;
  mode: 'read' | 'write';
}

export interface LockSet {
  /** Conflicts with every other request, in every project. */
  exclusive?: boolean;
  locks?: Lock[];
  /** Counts against this slot's limit while held. */
  slot?: string;
}

export const EXCLUSIVE: LockSet = { exclusive: true };

/** A snap name `n` is under prefix `p` when it is `p` or `p-…`. snapName
 *  output is [a-z0-9-], so the `-` is the only separator a prefix adds. */
const under = (n: string, p: string) => n === p || n.startsWith(`${p}-`);

export function keysConflict(a: LockKey, b: LockKey): boolean {
  if (a.project !== b.project) return false;
  if (a.kind === 'key' || b.kind === 'key')
    return a.kind === 'key' && b.kind === 'key' && a.key === b.key;
  if (a.kind === 'name' && b.kind === 'name') return a.name === b.name;
  if (a.kind === 'prefix' && b.kind === 'prefix')
    return under(a.prefix, b.prefix) || under(b.prefix, a.prefix);
  // A name against a prefix, either way round.
  return a.kind === 'name'
    ? b.kind === 'prefix' && under(a.name, b.prefix)
    : a.kind === 'prefix' && b.kind === 'name' && under(b.name, a.prefix);
}

export function setsConflict(a: LockSet, b: LockSet): boolean {
  if (a.exclusive || b.exclusive) return true;
  for (const la of a.locks ?? [])
    for (const lb of b.locks ?? [])
      if ((la.mode === 'write' || lb.mode === 'write') && keysConflict(la.key, lb.key))
        return true;
  return false;
}

/** One request. Its own object, so two requests passing the same LockSet
 *  (EXCLUSIVE) are still two holders. */
interface Waiter {
  set: LockSet;
  grant: (release: () => void) => void;
}

export class Scheduler {
  private readonly held = new Set<Waiter>();
  private readonly queue: Waiter[] = [];
  private readonly inUse = new Map<string, number>();

  constructor(private readonly slots: Record<string, number> = {}) {}

  /** Resolves with a release function once every lock in `set` is granted,
   *  or null if `signal` aborts first (the request is withdrawn and never
   *  holds anything). Release exactly once, when the work has settled. */
  acquire(set: LockSet, signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        set,
        grant: (release) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i < 0) return; // already granted; the holder releases
        this.queue.splice(i, 1);
        resolve(null);
        // A withdrawn waiter may have been the one blocking later requests.
        this.pump();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  /** Requests holding or waiting, for tests and diagnostics. */
  get size(): { held: number; waiting: number } {
    return { held: this.held.size, waiting: this.queue.length };
  }

  private pump(): void {
    const blocked: Waiter[] = [];
    for (let i = 0; i < this.queue.length;) {
      const w = this.queue[i];
      if (this.grantable(w.set, blocked)) {
        this.queue.splice(i, 1);
        this.take(w);
        let released = false;
        w.grant(() => {
          if (released) return;
          released = true;
          this.give(w);
          this.pump();
        });
      } else {
        blocked.push(w);
        i++;
      }
    }
  }

  private grantable(set: LockSet, earlierWaiting: Waiter[]): boolean {
    for (const h of this.held) if (setsConflict(set, h.set)) return false;
    // Arrival order among conflicting requests: this is the writer preference.
    for (const e of earlierWaiting) if (setsConflict(set, e.set)) return false;
    if (set.slot !== undefined) {
      const limit = this.slots[set.slot] ?? Infinity;
      if ((this.inUse.get(set.slot) ?? 0) >= limit) return false;
    }
    return true;
  }

  private take(w: Waiter): void {
    const { set } = w;
    this.held.add(w);
    if (set.slot !== undefined)
      this.inUse.set(set.slot, (this.inUse.get(set.slot) ?? 0) + 1);
  }

  private give(w: Waiter): void {
    const { set } = w;
    this.held.delete(w);
    if (set.slot !== undefined) this.inUse.set(set.slot, this.inUse.get(set.slot)! - 1);
  }
}
