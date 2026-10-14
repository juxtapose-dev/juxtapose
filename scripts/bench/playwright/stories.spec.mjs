// One screenshot assertion per story. 'default' mode uses Playwright's
// defaults (per-pixel color threshold 0.2); 'zero' mode sets threshold 0 and
// maxDiffPixels 0.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const ids = JSON.parse(readFileSync(process.env.BENCH_STORIES, 'utf8'));
const base = process.env.BENCH_URL;
const options = process.env.BENCH_MODE === 'zero' ? { threshold: 0, maxDiffPixels: 0 } : {};

for (const id of ids) {
  test(id, async ({ page }) => {
    await page.goto(`${base}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`);
    // Storybook marks the preview when the story has rendered (or errored).
    await page.waitForFunction(
      () =>
        document.body.classList.contains('sb-show-main') ||
        document.body.classList.contains('sb-show-errordisplay'),
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`${id}.png`, options);
  });
}
