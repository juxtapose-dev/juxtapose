import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { captureIo } from '../io.js';
import { approveCommand } from './approve.js';

test('approve --json prints an answer even when there is nothing to approve', async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'jux-approve-'));
  try {
    writeFileSync(
      path.join(project, 'juxtapose.config.json'),
      JSON.stringify({
        platform: 'urls',
        urls: [{ id: 'x', url: 'http://127.0.0.1:1/' }],
      }),
    );
    const run = path.join(project, '.juxtapose', 'runs', 'r1');
    mkdirSync(run, { recursive: true });
    writeFileSync(
      path.join(run, 'report.json'),
      JSON.stringify({ runId: 'r1', results: [{ storyId: 'x', status: 'pass' }] }),
    );
    const io = captureIo();
    expect(await approveCommand({ json: true, all: true, project }, { io })).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual({ approved: [], failed: [] });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
