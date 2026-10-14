// Config story overrides against a real Chrome (issue #128): a page whose
// content changes on every request is captured twice. Without an override the
// hashes differ; with a `mask` override they are byte-identical, and a
// `skip` override takes the story out of the run.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import type { Platform } from '../platform.js';
import type { StoryManifest, StoryOverride, StoryParams } from '../types.js';
import { capturePool } from './pool.js';
import { expandVariants } from './variants.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let hits = 0;

// The clock's text differs per request but its box is fixed, as `mask`
// requires; the rest is static.
const page = () => `<!doctype html><style>
  body { margin: 0; background: #fff; font: 16px sans-serif; }
  #clock { width: 120px; height: 24px; background: hsl(${(hits * 47) % 360} 80% 50%); }
  h1 { margin: 8px 0 0; }
</style><body><div id="clock">tick ${hits}</div><h1>Card</h1></body>`;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const platform: Platform = {
  name: 'fake',
  detect: async () => true,
  enumerate: async () => [],
  previewUrl: () => '',
  configDirs: [],
  storyFileGlobs: [],
  settle: async () => {},
  showStory: async (p, id) => {
    await p.goto(`${base}/${id}`);
  },
};

const story = (storyId: string, params: StoryParams = {}): StoryManifest => ({
  storyId,
  title: 'Card',
  name: storyId,
  componentPath: '',
  params,
});

async function hashes(
  browser: Browser,
  stories: StoryManifest[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const o of capturePool(stories, {
    browser,
    platform,
    baseUrl: base,
    viewport: { width: 200, height: 100 },
    concurrency: 1,
  })) {
    if (!o.snapshot) throw o.error ?? new Error(`no snapshot for ${o.story.storyId}`);
    out.set(o.story.storyId, createHash('sha256').update(o.snapshot.image).digest('hex'));
  }
  return out;
}

describe.skipIf(!chrome)('config story overrides in Chrome', () => {
  const run = async (overrides?: Record<string, StoryOverride>) => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const stories = expandVariants(
        [story('clock--live'), story('card--gone')],
        undefined,
        overrides,
      );
      const a = await hashes(browser, stories);
      const b = await hashes(browser, stories);
      return { a, b };
    } finally {
      await browser.close();
    }
  };

  it('unmasked, the changing element makes two captures differ', async () => {
    const { a, b } = await run();
    expect(a.get('clock--live')).not.toBe(b.get('clock--live'));
  });

  it('a mask override makes two captures byte-identical', async () => {
    const { a, b } = await run({ 'clock--*': { mask: ['#clock'] } });
    expect(a.get('clock--live')).toBe(b.get('clock--live'));
    expect(a.has('clock--live')).toBe(true);
  });

  it('a skip override omits the story from the capture', async () => {
    const { a, b } = await run({ 'card--gone': { skip: true } });
    expect(a.has('card--gone')).toBe(false);
    expect(b.has('card--gone')).toBe(false);
    expect(a.has('clock--live')).toBe(true);
  });
});
