import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Browser, RunReport } from '@juxtapose/core';
import { captureIo } from '../io.js';
import { runCommand } from './run.js';

test('a local skip-only run exits cleanly and saves explicit rows without capturing images', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-run-skips-'));
  try {
    writeFileSync(
      path.join(root, 'juxtapose.config.json'),
      JSON.stringify({
        platform: 'urls',
        urls: [{ id: 'home', url: 'http://127.0.0.1:1/' }],
        stories: { home: { skip: true } },
      }),
    );
    const newContext = vi.fn(async () => {
      throw new Error('skip must not capture');
    });
    const close = vi.fn(async () => {});
    const io = captureIo();
    const code = await runCommand(
      { project: root, all: true, json: true },
      {
        io,
        browser: async () =>
          ({ newContext, close, version: () => 'fixture' }) as unknown as Browser,
      },
    );
    expect(code, io.stderr()).toBe(0);
    const report = JSON.parse(io.stdout()) as RunReport;
    expect(report.summary).toEqual({ pass: 0, fail: 0, new: 0, stale: 0, skip: 1 });
    expect(report.capturedCount).toBe(1);
    expect(report.results).toEqual([
      expect.objectContaining({ storyId: 'home', status: 'skip' }),
    ]);
    expect(report.results[0]?.hash).toBeUndefined();
    const runDir = path.join(root, '.juxtapose', 'runs', report.runId);
    expect(JSON.parse(readFileSync(path.join(runDir, 'report.json'), 'utf8'))).toEqual(
      report,
    );
    expect(readdirSync(path.join(runDir, 'images'))).toEqual([]);
    expect(newContext).not.toHaveBeenCalled();
    // The caller retains ownership of a lent browser.
    expect(close).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
