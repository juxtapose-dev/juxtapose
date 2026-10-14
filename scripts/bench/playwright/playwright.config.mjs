// Environment:
//   BENCH_STORIES   JSON file: array of story ids (required)
//   BENCH_URL       base URL of the served Storybook (required)
//   BENCH_SNAP_DIR  baseline directory (required)
//   BENCH_JSON      where the JSON reporter writes (default results.json)
//   BENCH_MODE      'default' | 'zero'
//   BENCH_WORKERS   worker count; unset = Playwright's default (half the cores)
//   BENCH_CHROME    Chromium binary; unset = Playwright's own browser
import { defineConfig } from '@playwright/test';

const workers = process.env.BENCH_WORKERS ? Number(process.env.BENCH_WORKERS) : undefined;
const launchOptions = process.env.BENCH_CHROME
  ? { executablePath: process.env.BENCH_CHROME }
  : {};

export default defineConfig({
  testDir: '.',
  testMatch: 'stories.spec.mjs',
  fullyParallel: true,
  workers,
  retries: 0,
  reporter: [['json', { outputFile: process.env.BENCH_JSON ?? 'results.json' }]],
  snapshotPathTemplate: `${process.env.BENCH_SNAP_DIR}/{arg}{ext}`,
  use: { viewport: { width: 1280, height: 800 }, launchOptions },
});
