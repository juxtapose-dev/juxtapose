import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Browser, ConfirmOptions, Confirmation } from '@juxtapose/core';
import { captureIo } from '../io.js';

// A story the run captured once (recheck off, or "new" for a failing story)
// is confirmed by `jux approve` before it becomes a baseline (#195).

let confirmed: ConfirmOptions[] = [];
let unstableIds = new Set<string>();
let silent = new Set<string>();

vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  confirmCaptures: async (o: ConfirmOptions): Promise<Confirmation[]> => {
    confirmed.push(o);
    return o.stories
      .filter((s) => !silent.has(s.storyId))
      .map((s) => ({
        storyId: s.storyId,
        ...(unstableIds.has(s.storyId)
          ? { unstable: { hashes: [o.hashes.get(s.storyId)!, 'other'] } }
          : {}),
      }));
  },
}));

const { approveCommand } = await import('./approve.js');

const dirs: string[] = [];
let launched = 0;
const lent = async () => {
  launched++;
  return { version: () => '1.0', close: async () => {} } as unknown as Browser;
};
beforeEach(() => {
  confirmed = [];
  unstableIds = new Set();
  silent = new Set();
  launched = 0;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project with a finished run: `steady` and `flaky` were captured once
 *  (unrechecked); `twice` was rechecked by the run. */
function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-approve-confirm-'));
  dirs.push(root);
  const ids = ['steady', 'flaky', 'twice'];
  writeFileSync(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({
      platform: 'urls',
      urls: ids.map((id) => ({ id, url: `http://127.0.0.1:1/${id}` })),
    }),
  );
  const run = path.join(root, '.juxtapose', 'runs', 'r1');
  mkdirSync(path.join(run, 'images'), { recursive: true });
  for (const id of ids) writeFileSync(path.join(run, 'images', `${id}-current.webp`), id);
  writeFileSync(
    path.join(run, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      recheck: 'off',
      results: ids.map((id) => ({
        storyId: id,
        status: 'new',
        hash: `h-${id}`,
        ...(id === 'twice'
          ? {}
          : {
              unrechecked: true,
              unstable: {
                hashes: [`h-${id}`],
                unconfirmed: 'not rechecked (recheck off)',
              },
            }),
      })),
    }),
  );
  return root;
}

interface Answer {
  approved: string[];
  failed: { storyId: string; reason: string; unstable?: true }[];
}

async function approve(flags: Record<string, unknown> = {}) {
  const root = project();
  const io = captureIo();
  const code = await approveCommand(
    { json: true, all: true, project: root, ...flags },
    { io, browser: lent },
  );
  return { code, out: JSON.parse(io.stdout()) as Answer };
}

test('captures an unrechecked story again and approves it when the hashes match', async () => {
  const r = await approve();
  expect(confirmed).toHaveLength(1);
  // Only the stories the run did not recheck; one more capture each.
  expect([...confirmed[0]!.hashes]).toEqual([
    ['steady', 'h-steady'],
    ['flaky', 'h-flaky'],
  ]);
  expect(r.code).toBe(0);
  expect(r.out.approved.sort()).toEqual(['flaky', 'steady', 'twice']);
});

test('refuses an unrechecked story whose confirming capture differs', async () => {
  unstableIds = new Set(['flaky']);
  const r = await approve();
  expect(r.code).toBe(1);
  expect(r.out.approved.sort()).toEqual(['steady', 'twice']);
  expect(r.out.failed).toHaveLength(1);
  expect(r.out.failed[0]).toMatchObject({ storyId: 'flaky', unstable: true });
  expect(r.out.failed[0]!.reason).toMatch(/unstable: two captures of it differed/);
});

test('fails closed: an unrechecked story with no confirmation is refused', async () => {
  silent = new Set(['flaky']);
  const r = await approve();
  expect(r.out.approved.sort()).toEqual(['steady', 'twice']);
  expect(r.out.failed[0]).toMatchObject({ storyId: 'flaky', unstable: true });
  expect(r.out.failed[0]!.reason).toMatch(/no confirming capture was taken/);
});

test('--allow-unstable approves without the confirming capture', async () => {
  unstableIds = new Set(['flaky']);
  const r = await approve({ 'allow-unstable': true });
  expect(confirmed).toHaveLength(0);
  expect(launched).toBe(0);
  expect(r.out.approved.sort()).toEqual(['flaky', 'steady', 'twice']);
});

test('a run that rechecked everything launches no browser at approve', async () => {
  const root = project();
  const file = path.join(root, '.juxtapose', 'runs', 'r1', 'report.json');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const r of report.results) {
    delete r.unrechecked;
    delete r.unstable;
  }
  report.recheck = 'changed';
  writeFileSync(file, JSON.stringify(report));
  const io = captureIo();
  const code = await approveCommand(
    { json: true, all: true, project: root },
    { io, browser: lent },
  );
  expect(code).toBe(0);
  expect(launched).toBe(0);
  expect(confirmed).toHaveLength(0);
});
