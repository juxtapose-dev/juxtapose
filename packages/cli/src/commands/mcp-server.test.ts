// McpServer in-process, without a browser: what the scheduler lets start, and
// what a closed server refuses.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { McpServer } from './mcp.js';
import type { Scheduler } from '../scheduler.js';

const project = mkdtempSync(path.join(tmpdir(), 'jux-mcp-server-'));
afterAll(() => rmSync(project, { recursive: true, force: true }));

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');

test('calls cancelled together while queued never start (shutdown aborts in one loop)', async () => {
  const s = new McpServer({ project });
  const internals = s as unknown as { scheduler: Scheduler; project: string };
  // A snap holding `a`: the run behind it waits, and the diff waits behind the run.
  const hold = await internals.scheduler.acquire({
    locks: [
      { key: { kind: 'name', project: internals.project, name: 'a' }, mode: 'write' },
    ],
    slot: 'snap',
  });
  const c1 = new AbortController();
  const c2 = new AbortController();
  const run = s.call('run', {}, c1.signal);
  const diff = s.call('diff', { a: 'x', b: 'y' }, c2.signal);
  await new Promise((r) => setTimeout(r, 100));
  expect(internals.scheduler.size).toEqual({ held: 1, waiting: 2 });
  for (const c of [c1, c2]) c.abort();
  // Neither ran: a started diff would answer "no snap named 'x'".
  expect(text(await run)).toBe('jux: cancelled before it started');
  expect(text(await diff)).toBe('jux: cancelled before it started');
  hold!();
  expect(internals.scheduler.size).toEqual({ held: 0, waiting: 0 });
});

test('after close(), a straggling snap does not launch a browser', async () => {
  const s = new McpServer({ project, chrome: '/nonexistent/chrome-must-not-launch' });
  await s.close();
  const r = await s.call('snap', { url: 'http://127.0.0.1:1/', as: 'late' });
  expect(r.isError).toBe(true);
  expect(text(r)).toMatch(/shutting down/);
});
