import { beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DaemonStop } from '@juxtapose/core';

let results: DaemonStop[] = [];
vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  stopAllDaemons: async () => results,
}));

const unverified: DaemonStop = {
  key: 'k1',
  pid: 4242,
  outcome: 'unverified',
  reason: 'no /proc or ps to read its command line',
};

const { browserCommand } = await import('./browser.js');

describe('jux browser stop when the daemon cannot be verified', () => {
  beforeEach(() => {
    results = [unverified];
  });

  it('exits 3 and names the pid and that it could not be verified', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-bs-'));
    try {
      const bin = path.join(dir, 'chrome');
      writeFileSync(bin, '');
      const out: string[] = [];
      const err: string[] = [];
      const code = await browserCommand(['stop'], false, {
        env: { JUX_CHROME: bin, JUX_STATE_DIR: dir },
        write: (s) => out.push(s),
        writeErr: (s) => err.push(s),
      });
      expect(code).toBe(3);
      expect(err.join('')).toMatch(/pid 4242.*could not be verified/);
      expect(out.join('')).not.toMatch(/stopped|no warm browser/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json: the failure is one JSON object on stdout, still exit 3', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-bs-'));
    try {
      const bin = path.join(dir, 'chrome');
      writeFileSync(bin, '');
      const out: string[] = [];
      const code = await browserCommand(['stop', '--json'], false, {
        env: { JUX_CHROME: bin, JUX_STATE_DIR: dir },
        write: (s) => out.push(s),
        writeErr: () => {},
      });
      expect(code).toBe(3);
      expect(JSON.parse(out.join(''))).toMatchObject({
        ok: false,
        stopped: false,
        pid: 4242,
        error: expect.stringMatching(/could not be verified/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pid still alive after SIGTERM is not reported stopped; one that went is listed', async () => {
    results = [
      { key: 'k0', pid: 11, outcome: 'stopped' },
      {
        key: 'k1',
        pid: 12,
        outcome: 'running',
        reason: 'it was signalled but had not exited after 2 s',
      },
    ];
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-bs-'));
    try {
      const out: string[] = [];
      const code = await browserCommand(['stop', '--json'], false, {
        env: { JUX_STATE_DIR: dir },
        write: (s) => out.push(s),
        writeErr: () => {},
      });
      expect(code).toBe(3);
      expect(JSON.parse(out.join(''))).toMatchObject({
        ok: false,
        stopped: true,
        stoppedPids: [11],
        pid: 12,
        notStopped: [{ pid: 12, key: 'k1', outcome: 'running' }],
        error: expect.stringMatching(/pid 12 is still running/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
