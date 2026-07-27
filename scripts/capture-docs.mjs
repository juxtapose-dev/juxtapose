// Capture the documentation media: screenshots of the addon panel, and a GIF
// of the comparison modes.
//
// A visual testing tool whose README has no picture of a diff is asking the
// reader to take the whole premise on faith. These are regenerated rather than
// hand-taken so they cannot drift from what the addon actually renders.
//
// Usage:
//   1. Start the example Storybook with a real diff present:
//        cd examples/storybook && pnpm storybook dev -p 6020
//        (with examples/components edited so some stories fail)
//   2. node scripts/capture-docs.mjs [port]
//
// Output lands in docs/media/, which .gitignore negates for png and gif.

import { mkdir, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Playwright is a dependency of @juxtapose/cli, not of the root, and Node
// resolves bare imports relative to this file rather than the cwd. Resolve it
// through the CLI package instead of hardcoding a .pnpm path that a version
// bump would invalidate.
const require = createRequire(import.meta.url);
const playwrightPath = require.resolve('playwright', {
  paths: [path.resolve('packages/cli')],
});
// Playwright is CommonJS, so its named exports arrive under `.default` when
// pulled in through a dynamic import rather than a bare `import` statement.
const playwright = await import(pathToFileURL(playwrightPath).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const run = promisify(execFile);
const PORT = process.argv[2] ?? '6020';
const BASE = `http://localhost:${PORT}`;
const OUT = path.resolve('docs/media');
const FRAMES = path.resolve('docs/media/.frames');

// A 2x device scale factor makes the images legible on the retina displays
// most readers use. This is documentation, not a capture — determinism does
// not apply, so we optimise for looking right instead.
const VIEWPORT = { width: 1440, height: 820 };

/** The panel renders asynchronously off a poll; give it a beat to settle. */
const settle = (page, ms = 900) => page.waitForTimeout(ms);

async function openPanel(page, storyId) {
  await page.goto(`${BASE}/?path=/story/${storyId}`, { waitUntil: 'networkidle' });
  // The addon tab is titled "Visual". Storybook renders the panel lazily, so
  // it has to be clicked before anything inside it exists.
  const tab = page.getByRole('tab', { name: /visual/i });
  await tab.waitFor({ timeout: 30_000 });
  await tab.click();
  await dismissChrome(page);
  await enlargePanel(page);
  await settle(page);
}

/**
 * Get Storybook's own furniture out of the frame.
 *
 * The release-notes toast is the main offender: it is not our UI, and it dates
 * every screenshot to whatever Storybook version happened to be installed.
 */
async function dismissChrome(page) {
  for (const name of [/dismiss/i, /close/i]) {
    const close = page.getByRole('button', { name });
    const n = await close.count();
    for (let i = 0; i < n; i++) {
      await close
        .nth(i)
        .click({ timeout: 1000 })
        .catch(() => {});
    }
  }
  await page.waitForTimeout(300);
}

/**
 * Drag the panel divider up.
 *
 * The panel is the subject, but Storybook's default split gives it a third of
 * the height and hands the rest to one small button on a lot of white.
 */
async function enlargePanel(page) {
  const box = await page.locator('[role="tablist"]').first().boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + 300, box.y - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y - 190, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/**
 * Screenshot, cropped around the panel.
 *
 * A full-window shot spends half its pixels on an empty story canvas, but
 * cropping to the panel alone loses the sidebar status dots — which are the
 * addon's, not Storybook's. The strip above keeps both.
 */
async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  const panel = await page.locator('[role="tablist"]').first().boundingBox();
  // Start just below the preview so a half-rendered component cannot bleed in
  // from above, and stop at whatever the panel's own content needs.
  const clip = panel
    ? {
        x: 0,
        y: Math.max(0, panel.y - PREVIEW_STRIP),
        width: VIEWPORT.width,
        height: Math.min(VIEWPORT.height - panel.y + PREVIEW_STRIP, PANEL_HEIGHT),
      }
    : undefined;
  await page.screenshot({ path: file, clip });
  console.log(`  wrote ${path.relative(process.cwd(), file)}`);
}

/** Keep enough of the story preview that the sidebar's status dots — one of
 *  the addon's own features — stay in frame. */
const PREVIEW_STRIP = 300;
/** Enough for the controls, both images and the footer; beyond this the panel
 *  is padding, and a screenshot of padding reads as an empty tool. */
const PANEL_HEIGHT = 620;

async function main() {
  await mkdir(OUT, { recursive: true });
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  try {
    // 1. The panel showing a real diff, which is the money shot.
    console.log('panel: changed story');
    await openPanel(page, 'button--large');
    await shoot(page, 'addon-panel');

    // 2. Each comparison mode, and the frames for the GIF. Cycling through
    //    them is the thing a still cannot convey.
    const modes = ['Side by side', 'Slider', 'Onion', 'Flicker'];
    for (const [i, mode] of modes.entries()) {
      const button = page.getByRole('button', { name: mode });
      if ((await button.count()) === 0) {
        console.log(`  (no "${mode}" control — skipping)`);
        continue;
      }
      await button.first().click();
      await settle(page, 700);
      const slug = mode.toLowerCase().replace(/\s+/g, '-');
      await shoot(page, `mode-${slug}`);
      // Frames are numbered so ffmpeg's glob picks them up in order.
      await page.screenshot({
        path: path.join(FRAMES, `${String(i).padStart(2, '0')}.png`),
      });
    }

    // 3. A story with no diff — the "nothing to see" state, which is what
    //    most stories look like most of the time.
    console.log('panel: passing story');
    await openPanel(page, 'card--default');
    await shoot(page, 'addon-panel-passing');
  } finally {
    await browser.close();
  }

  await buildGif();
}

/**
 * Assemble the mode frames into a looping GIF.
 *
 * Two-pass palette generation: a GIF is limited to 256 colours, and ffmpeg's
 * default quantiser produces visible banding on UI screenshots. Generating a
 * palette from the actual frames first is the difference between crisp text
 * and mush.
 */
async function buildGif() {
  const frames = (await readdir(FRAMES)).filter((f) => f.endsWith('.png'));
  if (frames.length < 2) {
    console.log('gif: fewer than two frames, skipping');
    return;
  }

  const palette = path.join(FRAMES, 'palette.png');
  const input = path.join(FRAMES, '%02d.png');
  const gif = path.join(OUT, 'addon-modes.gif');

  await run('ffmpeg', [
    '-y',
    '-framerate',
    '1',
    '-i',
    input,
    '-vf',
    'scale=900:-1:flags=lanczos,palettegen=stats_mode=diff',
    palette,
  ]);
  await run('ffmpeg', [
    '-y',
    '-framerate',
    '1',
    '-i',
    input,
    '-i',
    palette,
    '-lavfi',
    'scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer',
    '-loop',
    '0',
    gif,
  ]);

  await rm(FRAMES, { recursive: true, force: true });
  console.log(`  wrote ${path.relative(process.cwd(), gif)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
