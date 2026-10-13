// The scheduler's grant order and compatibility, without a browser: what may
// run beside what, and in which order the rest is granted.

import { describe, expect, test } from 'vitest';
import {
  EXCLUSIVE,
  keysConflict,
  Scheduler,
  type LockKey,
  type LockSet,
} from './scheduler.js';

const P = '/project';
const name = (n: string, project = P): LockKey => ({ kind: 'name', project, name: n });
const prefix = (p: string, project = P): LockKey => ({
  kind: 'prefix',
  project,
  prefix: p,
});
const key = (k: string, project = P): LockKey => ({ kind: 'key', project, key: k });

const snap = (k: LockKey): LockSet => ({
  locks: [{ key: k, mode: 'write' }],
  slot: 'snap',
});
const diff = (a: LockKey, b: LockKey, crops?: string): LockSet => ({
  locks: [
    { key: a, mode: 'read' },
    { key: b, mode: 'read' },
    ...(crops ? [{ key: key(crops), mode: 'write' as const }] : []),
  ],
});
const readsRun: LockSet = { locks: [{ key: key('run'), mode: 'read' }] };

/** Requests in arrival order, recording when each is granted. */
function harness(slots: Record<string, number> = {}) {
  const s = new Scheduler(slots);
  const granted: string[] = [];
  const releases = new Map<string, () => void>();
  const outcomes = new Map<string, Promise<boolean>>();
  return {
    s,
    granted,
    request(label: string, set: LockSet, signal?: AbortSignal) {
      const p = s.acquire(set, signal).then((release) => {
        if (!release) return false;
        granted.push(label);
        releases.set(label, release);
        return true;
      });
      outcomes.set(label, p);
      return p;
    },
    release(label: string) {
      const r = releases.get(label);
      if (!r) throw new Error(`${label} does not hold`);
      r();
    },
    outcome: (label: string) => outcomes.get(label)!,
  };
}

/** Grants resolve on microtasks; let them all land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('lock keys', () => {
  test('compat matrix: names, prefixes, opaque keys, projects', () => {
    expect(keysConflict(name('before'), name('before'))).toBe(true);
    expect(keysConflict(name('before'), name('after'))).toBe(false);
    // A prefix covers every `<prefix>-*` name, both ways round.
    expect(keysConflict(prefix('before'), name('before-home'))).toBe(true);
    expect(keysConflict(name('before-home'), prefix('before'))).toBe(true);
    expect(keysConflict(prefix('before'), name('beforehand'))).toBe(false);
    expect(keysConflict(prefix('before-home'), name('before'))).toBe(false);
    // Nested prefixes overlap: `a` writes `a-b-home`, which is `a-b`'s too.
    expect(keysConflict(prefix('a'), prefix('a-b'))).toBe(true);
    expect(keysConflict(prefix('a-b'), prefix('a'))).toBe(true);
    expect(keysConflict(prefix('a'), prefix('ab'))).toBe(false);
    expect(keysConflict(key('run'), key('run'))).toBe(true);
    expect(keysConflict(key('run'), name('run'))).toBe(false);
    // Two projects never contend.
    expect(keysConflict(name('before', '/x'), name('before', '/y'))).toBe(false);
    expect(keysConflict(prefix('a', '/x'), name('a-b', '/y'))).toBe(false);
  });
});

describe('Scheduler', () => {
  test('snaps of different names run together; the same name takes turns', async () => {
    const h = harness();
    void h.request('s1', snap(name('a')));
    void h.request('s2', snap(name('b')));
    void h.request('s3', snap(name('a')));
    await settle();
    expect(h.granted).toEqual(['s1', 's2']);
    h.release('s1');
    await settle();
    expect(h.granted).toEqual(['s1', 's2', 's3']);
  });

  test('a prefix snap and a snap of a name under it are serialized', async () => {
    const h = harness();
    void h.request('set', snap(prefix('before')));
    void h.request('one', snap(name('before-home')));
    void h.request('other', snap(name('after-home')));
    await settle();
    expect(h.granted).toEqual(['set', 'other']);
    h.release('set');
    await settle();
    expect(h.granted).toContain('one');
  });

  test('diff waits for a snap writing its input, and two diffs read together', async () => {
    const h = harness();
    void h.request('snap-after', snap(name('after')));
    void h.request('diff', diff(name('before'), name('after')));
    void h.request('diff-before-only', diff(name('before'), name('other')));
    await settle();
    expect(h.granted).toEqual(['snap-after', 'diff-before-only']);
    h.release('snap-after');
    await settle();
    expect(h.granted).toEqual(['snap-after', 'diff-before-only', 'diff']);
  });

  test('diffs of one pair with crops take turns on the crops dir', async () => {
    const h = harness();
    void h.request('c1', diff(name('a'), name('b'), 'crops/a~vs~b'));
    void h.request('c2', diff(name('a'), name('b'), 'crops/a~vs~b'));
    void h.request('c3', diff(name('a'), name('c'), 'crops/a~vs~c'));
    await settle();
    expect(h.granted).toEqual(['c1', 'c3']);
  });

  test('run excludes everything, in every project, and waits for what holds', async () => {
    const h = harness();
    void h.request('snap', snap(name('a')));
    void h.request('run', EXCLUSIVE);
    void h.request('check', readsRun);
    void h.request('elsewhere', snap(name('z', '/other')));
    await settle();
    expect(h.granted).toEqual(['snap']);
    h.release('snap');
    await settle();
    expect(h.granted).toEqual(['snap', 'run']);
    h.release('run');
    await settle();
    expect(h.granted).toEqual(['snap', 'run', 'check', 'elsewhere']);
  });

  test('two exclusive requests sharing one LockSet object are still two holders', async () => {
    const h = harness();
    void h.request('r1', EXCLUSIVE);
    void h.request('r2', EXCLUSIVE);
    await settle();
    expect(h.granted).toEqual(['r1']);
    h.release('r1');
    await settle();
    expect(h.granted).toEqual(['r1', 'r2']);
  });

  test('writer preference: a waiting writer is not starved by readers that keep arriving', async () => {
    const h = harness();
    void h.request('read-1', diff(name('a'), name('b')));
    void h.request('write', snap(name('a')));
    // Compatible with read-1, but it arrived after the waiting writer.
    void h.request('read-2', diff(name('a'), name('c')));
    await settle();
    expect(h.granted).toEqual(['read-1']);
    h.release('read-1');
    await settle();
    expect(h.granted).toEqual(['read-1', 'write']);
    h.release('write');
    await settle();
    expect(h.granted).toEqual(['read-1', 'write', 'read-2']);
  });

  test('a waiting run is not starved by snaps of fresh names', async () => {
    const h = harness();
    void h.request('s0', snap(name('n0')));
    void h.request('run', EXCLUSIVE);
    for (let i = 1; i <= 5; i++) void h.request(`s${i}`, snap(name(`n${i}`)));
    await settle();
    expect(h.granted).toEqual(['s0']);
    h.release('s0');
    await settle();
    expect(h.granted).toEqual(['s0', 'run']);
  });

  test('FIFO among compatible waiters', async () => {
    const h = harness();
    void h.request('w', snap(name('a')));
    void h.request('r1', diff(name('a'), name('x')));
    void h.request('r2', diff(name('a'), name('y')));
    void h.request('r3', diff(name('a'), name('z')));
    await settle();
    h.release('w');
    await settle();
    expect(h.granted).toEqual(['w', 'r1', 'r2', 'r3']);
  });

  test('the snap slot limit caps concurrent snaps; the rest wait in order', async () => {
    const h = harness({ snap: 2 });
    for (const n of ['a', 'b', 'c', 'd']) void h.request(n, snap(name(n)));
    // Not a snap: the slot does not hold it back.
    void h.request('diff', diff(name('x'), name('y')));
    await settle();
    expect(h.granted).toEqual(['a', 'b', 'diff']);
    h.release('b');
    await settle();
    expect(h.granted).toEqual(['a', 'b', 'diff', 'c']);
    h.release('a');
    await settle();
    expect(h.granted).toEqual(['a', 'b', 'diff', 'c', 'd']);
  });

  test('a call cancelled while queued never starts, and stops blocking later calls', async () => {
    const h = harness();
    void h.request('snap', snap(name('a')));
    const ac = new AbortController();
    void h.request('queued-run', EXCLUSIVE, ac.signal);
    void h.request('other', snap(name('b')));
    await settle();
    expect(h.granted).toEqual(['snap']);
    ac.abort();
    await settle();
    expect(await h.outcome('queued-run')).toBe(false);
    expect(h.granted).toEqual(['snap', 'other']);
    h.release('snap');
    await settle();
    expect(h.granted).not.toContain('queued-run');
    expect(h.s.size).toEqual({ held: 1, waiting: 0 });
  });

  test('an already aborted signal is never granted', async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    expect(await h.request('x', snap(name('a')), ac.signal)).toBe(false);
    expect(h.s.size).toEqual({ held: 0, waiting: 0 });
  });

  test('a call cancelled while running keeps its locks until it releases', async () => {
    const h = harness();
    const ac = new AbortController();
    void h.request('running', snap(name('a')), ac.signal);
    await settle();
    ac.abort();
    void h.request('next', snap(name('a')));
    await settle();
    expect(h.granted).toEqual(['running']);
    h.release('running');
    // Releasing twice is harmless: the second does not free someone else's.
    h.release('running');
    await settle();
    expect(h.granted).toEqual(['running', 'next']);
    expect(h.s.size).toEqual({ held: 1, waiting: 0 });
  });

  test("requests aborted together are never granted, even by each other's withdrawal", async () => {
    // A shutdown aborts every call in one loop. Withdrawing the first pumps
    // the queue before the second's abort listener runs; the second must not
    // be granted in that gap.
    const h = harness();
    void h.request('hold', snap(name('a')));
    const c1 = new AbortController();
    const c2 = new AbortController();
    void h.request('run', EXCLUSIVE, c1.signal);
    void h.request('diff', diff(name('x'), name('y')), c2.signal);
    await settle();
    for (const c of [c1, c2]) c.abort();
    expect(await h.outcome('run')).toBe(false);
    expect(await h.outcome('diff')).toBe(false);
    expect(h.granted).toEqual(['hold']);
    expect(h.s.size).toEqual({ held: 1, waiting: 0 });
  });

  test('a ticket keeps its place while the caller plans: later conflicting requests wait', async () => {
    const h = harness();
    const t = h.s.ticket();
    void h.request('later', snap(name('a')));
    await settle();
    // Planning: the ticket's locks are unknown, so nothing after it may pass.
    expect(h.granted).toEqual([]);
    const first = t.acquire(diff(name('a'), name('b')));
    expect(await first).toBeTypeOf('function');
    await settle();
    // The diff (arrived first) holds; the snap of `a` waits for it.
    expect(h.granted).toEqual([]);
    (await first)!();
    await settle();
    expect(h.granted).toEqual(['later']);
  });

  test('a cancelled ticket stops holding its place', async () => {
    const h = harness();
    const t = h.s.ticket();
    void h.request('later', snap(name('a')));
    await settle();
    expect(h.granted).toEqual([]);
    t.cancel();
    await settle();
    expect(h.granted).toEqual(['later']);
    expect(() => t.acquire(EXCLUSIVE)).toThrow(/already used/);
  });

  test('overlapping multi-key sets never deadlock: every request completes', async () => {
    // Dining philosophers: each request needs two adjacent keys, in opposite
    // orders. Lock-at-a-time would deadlock; all-or-nothing cannot.
    const s = new Scheduler({ snap: 3 });
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4'].map((k) => key(k));
    let done = 0;
    const work = Array.from({ length: 40 }, async (_, i) => {
      const a = keys[i % 5];
      const b = keys[(i + (i % 2 ? 1 : 4)) % 5];
      const set: LockSet = {
        locks: [
          { key: a, mode: i % 3 ? 'write' : 'read' },
          { key: b, mode: 'write' },
        ],
        ...(i % 4 === 0 ? { slot: 'snap' } : {}),
        ...(i % 13 === 0 ? { exclusive: true } : {}),
      };
      const release = await s.acquire(set);
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      release!();
      done++;
    });
    await Promise.all(work);
    expect(done).toBe(40);
    expect(s.size).toEqual({ held: 0, waiting: 0 });
  });
});
