// `timings` on a real capture: every phase is present and non-negative, and the
// phases plus `other` add up to durationMs. They are clock reads around calls
// capture already made, so the second thing guarded is that they cannot change
// the bytes: two captures of one page hash the same whatever the timings say.

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { createUrlPlatform } from '../platforms/urls.js';
import type { CaptureTimings, Snapshot } from '../types.js';
import { captureStory } from './capture.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><h1>timings</h1><p>one</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server.close();
});

const PHASES: (keyof CaptureTimings)[] = [
  'navigate',
  'freshRenderer',
  'render',
  'settle',
  'paint',
  'structure',
  'screenshot',
  'encode',
  'other',
];

describe.skipIf(!chrome)('capture timings in Chrome', { timeout: 30_000 }, () => {
  it('reports every phase, and they sum to durationMs', async () => {
    const viewport = { width: 320, height: 120 };
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      const snaps: Snapshot[] = [];
      // Twice on one page: the second takes the fresh-renderer hop.
      for (const k of [0, 1]) {
        const platform = createUrlPlatform([{ id: `t${k}`, url: base }]);
        const [story] = await platform.enumerate({ projectRoot: process.cwd() });
        const s = await captureStory(
          page,
          story!,
          { platform, baseUrl: base, renderer: { shared: false } },
          viewport,
        );
        snaps.push(s!);
      }
      for (const s of snaps) {
        const t = s.timings;
        expect(t).toBeDefined();
        for (const name of PHASES) {
          expect(Number.isFinite(t![name]), name).toBe(true);
          expect(t![name], name).toBeGreaterThanOrEqual(0);
        }
        const sum = PHASES.reduce((a, name) => a + t![name], 0);
        // durationMs is Date.now() wall-clock to the ms, timings are 0.1 ms.
        expect(Math.abs(sum - s.durationMs)).toBeLessThan(5);
        expect(t!.screenshot).toBeGreaterThan(0);
        expect(t!.encode).toBeGreaterThan(0);
      }
      expect(snaps[0]!.timings!.freshRenderer).toBe(0);
      expect(snaps[1]!.timings!.freshRenderer).toBeGreaterThan(0);
      const hash = (s: Snapshot) => createHash('sha256').update(s.image).digest('hex');
      expect(hash(snaps[1]!)).toBe(hash(snaps[0]!));
    } finally {
      await context.close();
    }
  });
});
