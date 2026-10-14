// Bad settle options are usage errors that name where they came from, and
// none of them reaches a browser.

import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureIo } from '../io.js';
import { runCommand } from './run.js';
import { snapCommand } from './snap.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(config: object): string {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-settle-'));
  dirs.push(root);
  writeFileSync(path.join(root, 'juxtapose.config.json'), JSON.stringify(config));
  return root;
}

const home = { id: 'home', url: 'http://127.0.0.1:1/' };
const noBrowser = () => Promise.reject(new Error('launched a browser'));

test('a bad project settle exits 2 naming the project config (run and snap)', async () => {
  const root = project({ platform: 'urls', urls: [home], settle: { timeout: 'soon' } });
  const io = captureIo();
  expect(await runCommand({ project: root, all: true }, { io, browser: noBrowser })).toBe(
    2,
  );
  expect(io.stderr()).toContain(
    'jux: project config: settle.timeout must be a whole number of ms from 1 to 60000, got "soon"',
  );
  const snapIo = captureIo();
  expect(
    await snapCommand(
      ['http://127.0.0.1:1/'],
      { project: root, as: 'x' },
      {
        io: snapIo,
        browser: noBrowser,
      },
    ),
  ).toBe(2);
  expect(snapIo.stderr()).toContain('jux: project config: settle.timeout');
});

test('a bad story settle exits 2 naming the story', async () => {
  const root = project({
    platform: 'urls',
    urls: [{ ...home, params: { settle: { network: { ignore: '/poll' } } } }],
  });
  const io = captureIo();
  expect(await runCommand({ project: root, all: true }, { io, browser: noBrowser })).toBe(
    2,
  );
  expect(io.stderr()).toContain(
    "jux: story 'home': settle.network.ignore must be an array of URL patterns",
  );
});

test('a bad --settle-timeout exits 2 before anything else', async () => {
  const root = project({ platform: 'urls', urls: [home] });
  const io = captureIo();
  expect(
    await runCommand(
      { project: root, all: true, 'settle-timeout': '0' },
      { io, browser: noBrowser },
    ),
  ).toBe(2);
  expect(io.stderr()).toContain('jux run: --settle-timeout must be a whole number');
});
