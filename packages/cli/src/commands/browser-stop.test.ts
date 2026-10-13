import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  stopDaemon: async () => ({ outcome: 'unverified', pid: 4242 }),
}));

const { browserCommand } = await import('./browser.js');

describe('jux browser stop when the daemon cannot be verified', () => {
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
});
