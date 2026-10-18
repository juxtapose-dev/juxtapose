// `jux snap --device / --orientation`: the flags are the story layer, a bad
// one is a usage error before any browser launches, and the retry line repeats
// them.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Browser, SnapPagesOptions } from '@juxtapose/core';
import { captureIo } from '../io.js';

let seen: SnapPagesOptions | undefined;
vi.mock('@juxtapose/core', async (orig) => ({
  ...(await orig<typeof import('@juxtapose/core')>()),
  snapPages: async (opts: SnapPagesOptions) => {
    seen = opts;
    return {
      env: { browser: '1', os: 'x', encoder: 'e' },
      pages: opts.urls.map((url) => ({ url, status: 200, error: 'boom' })),
    };
  },
}));

const { snapCommand } = await import('./snap.js');

const dirs: string[] = [];
afterEach(() => {
  seen = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(config: object = { platform: 'urls', urls: [] }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-snap-device-'));
  dirs.push(root);
  writeFileSync(path.join(root, 'juxtapose.config.json'), JSON.stringify(config));
  return root;
}

const lent = () => Promise.resolve({ close: async () => {} } as unknown as Browser);
const noBrowser = () => Promise.reject(new Error('launched a browser'));
const url = 'http://127.0.0.1:1/';

test('--device and --orientation are story-layer params', async () => {
  await snapCommand(
    [url],
    { project: project(), as: 'x', device: 'mobile', orientation: 'landscape' },
    { io: captureIo(), browser: lent },
  );
  expect(seen?.params).toMatchObject({ device: 'mobile', orientation: 'landscape' });
});

test('snap hands the project devices to the capture, and accepts them by name', async () => {
  const root = project({
    platform: 'urls',
    urls: [],
    devices: { kiosk: { width: 1080, height: 1920 } },
  });
  const io = captureIo();
  await snapCommand(
    [url],
    { project: root, as: 'x', device: 'kiosk' },
    { io, browser: lent },
  );
  expect(io.stderr()).not.toContain('unknown device');
  expect(seen?.devices?.get('kiosk')).toMatchObject({ width: 1080, height: 1920 });
  expect(seen?.devices?.has('iphone-15')).toBe(true);
});

test('an unknown device exits 2 with a suggestion, before a browser', async () => {
  const io = captureIo();
  const code = await snapCommand(
    [url],
    { project: project(), as: 'x', device: 'iphone15' },
    { io, browser: noBrowser },
  );
  expect(code).toBe(2);
  expect(io.stderr()).toContain("unknown device 'iphone15'; did you mean iphone-15");
  expect(seen).toBeUndefined();
});

test('--orientation sideways is a usage error before a browser', async () => {
  const io = captureIo();
  const code = await snapCommand(
    [url],
    { project: project(), as: 'x', orientation: 'sideways' },
    { io, browser: noBrowser },
  );
  expect(code).toBe(2);
  expect(io.stderr()).toContain(
    "jux snap: --orientation must be portrait or landscape, got 'sideways'",
  );
});

test('--viewport is a story-layer size beside --device, not only the fallback', async () => {
  await snapCommand(
    [url],
    { project: project(), as: 'x', device: 'pixel-8', viewport: '412x600' },
    { io: captureIo(), browser: lent },
  );
  expect(seen?.params).toMatchObject({
    device: 'pixel-8',
    viewport: { width: 412, height: 600 },
  });
});

test('--viewport beside --orientation is not rotated', async () => {
  await snapCommand(
    [url],
    { project: project(), as: 'x', orientation: 'landscape', viewport: '400x300' },
    { io: captureIo(), browser: lent },
  );
  expect(seen?.params).toMatchObject({
    orientation: 'landscape',
    viewport: { width: 400, height: 300 },
  });
});

test('the retry line repeats --device and --orientation', async () => {
  const io = captureIo();
  const code = await snapCommand(
    [url],
    { project: project(), as: 'x', device: 'mobile', orientation: 'landscape' },
    { io, browser: lent },
  );
  expect(code).toBe(3);
  expect(io.stdout()).toMatch(/retry: .*--device mobile --orientation landscape/);
});

// resolveDevices threw a plain Error from inside snapCommand, which the CLI
// reported as an unexpected failure (exit 3).
test('a device cycle in the project config is a config error, exit 2', async () => {
  const io = captureIo();
  const code = await snapCommand(
    [url],
    {
      project: project({
        platform: 'urls',
        urls: [],
        devices: { a: { extends: 'b' }, b: { extends: 'a' } },
      }),
      as: 'x',
    },
    { io, browser: noBrowser },
  );
  expect(code).toBe(2);
  expect(io.stderr()).toContain('device cycle: a -> b -> a');
  expect(io.stderr()).not.toContain('unexpected failure');
});
