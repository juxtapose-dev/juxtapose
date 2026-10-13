// CLI plumbing for per-story variants: `run --story` selection errors and
// variant config errors exit 2 before a browser launches, and `approve
// --story <base id>` approves every variant of it in the run.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeStoryId } from '@juxtapose/core';
import { afterEach, expect, test } from 'vitest';
import { captureIo } from '../io.js';
import { approveCommand } from './approve.js';
import { runCommand } from './run.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(config: object): string {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-variants-'));
  dirs.push(root);
  writeFileSync(path.join(root, 'juxtapose.config.json'), JSON.stringify(config));
  return root;
}

const urls = [
  { id: 'home', url: 'http://127.0.0.1:1/' },
  { id: 'about', url: 'http://127.0.0.1:1/about' },
];

/** A lent browser that fails the test if anything tries to launch one. */
const noBrowser = () => Promise.reject(new Error('launched a browser'));

test('run --story with an unknown id exits 2 and lists every unknown id', async () => {
  const root = project({
    platform: 'urls',
    urls,
    variants: { dark: { colorScheme: 'dark' } },
  });
  const io = captureIo();
  const code = await runCommand(
    { project: root, story: ['home__dark', 'nope', 'home__light'] },
    { io, browser: noBrowser },
  );
  expect(code).toBe(2);
  expect(io.stderr()).toContain("no story or capture with id 'nope', 'home__light'");
});

test('a variant config error exits 2 naming the story and variant', async () => {
  const root = project({
    platform: 'urls',
    urls: [{ ...urls[0], variants: { mobile: { extends: 'tablet' } } }],
  });
  const io = captureIo();
  expect(await runCommand({ project: root, all: true }, { io, browser: noBrowser })).toBe(
    2,
  );
  expect(io.stderr()).toContain(
    "story 'home' variant 'mobile' extends unknown variant 'tablet'",
  );
});

test('a bad project variant name exits 2', async () => {
  const root = project({ platform: 'urls', urls, variants: { Dark: {} } });
  const io = captureIo();
  expect(await runCommand({ project: root, all: true }, { io, browser: noBrowser })).toBe(
    2,
  );
  expect(io.stderr()).toContain("project config: variant name 'Dark'");
});

test('approve --story <base id> approves the story and all its variants; a key approves one', async () => {
  const root = project({ platform: 'urls', urls });
  const run = path.join(root, '.juxtapose', 'runs', 'r1');
  mkdirSync(path.join(run, 'images'), { recursive: true });
  const results = [
    { storyId: 'about', status: 'new' },
    { storyId: 'home', status: 'new' },
    { storyId: 'home__dark', baseStoryId: 'home', variant: 'dark', status: 'new' },
    { storyId: 'home__mobile', baseStoryId: 'home', variant: 'mobile', status: 'new' },
  ];
  writeFileSync(path.join(run, 'report.json'), JSON.stringify({ runId: 'r1', results }));
  for (const r of results) {
    writeFileSync(
      path.join(run, 'images', `${encodeStoryId(r.storyId)}-current.webp`),
      Buffer.from(r.storyId),
    );
  }

  const io = captureIo();
  expect(
    await approveCommand({ json: true, project: root, story: ['home'] }, { io }),
  ).toBe(0);
  expect(JSON.parse(io.stdout())).toEqual({
    approved: ['home', 'home__dark', 'home__mobile'],
    failed: [],
  });

  const io2 = captureIo();
  expect(
    await approveCommand(
      { json: true, project: root, story: ['about', 'home__dark'] },
      { io: io2 },
    ),
  ).toBe(0);
  expect(JSON.parse(io2.stdout()).approved).toEqual(['about', 'home__dark']);

  const manifest = JSON.parse(
    readFileSync(path.join(root, 'juxtapose.manifest.json'), 'utf8'),
  ) as { baselines: Record<string, unknown> };
  expect(Object.keys(manifest.baselines).sort()).toEqual([
    'about',
    'home',
    'home__dark',
    'home__mobile',
  ]);
});

/** A run of `card` (new) and its variants with the given statuses; only
 *  captures that produced an image get one, like a real run. */
function runWith(root: string, variants: Array<{ variant: string; status: string }>) {
  const run = path.join(root, '.juxtapose', 'runs', 'r1');
  mkdirSync(path.join(run, 'images'), { recursive: true });
  const results = [
    { storyId: 'card', status: 'new' },
    ...variants.map((v) => ({
      storyId: `card__${v.variant}`,
      baseStoryId: 'card',
      variant: v.variant,
      status: v.status,
    })),
  ];
  writeFileSync(path.join(run, 'report.json'), JSON.stringify({ runId: 'r1', results }));
  for (const r of results) {
    if (r.status === 'skip') continue;
    writeFileSync(
      path.join(run, 'images', `${encodeStoryId(r.storyId)}-current.webp`),
      Buffer.from(r.storyId),
    );
  }
}

const manifestOf = (root: string) =>
  JSON.parse(readFileSync(path.join(root, 'juxtapose.manifest.json'), 'utf8')) as {
    baselines: Record<string, { hash: string; approvedAt: string }>;
  };

test('approve by base id leaves a skipped variant alone instead of failing on its missing image', async () => {
  const root = project({ platform: 'urls', urls: [urls[0]] });
  runWith(root, [{ variant: 'dark', status: 'skip' }]);
  const io = captureIo();
  expect(
    await approveCommand({ json: true, project: root, story: ['card'] }, { io }),
  ).toBe(0);
  expect(JSON.parse(io.stdout())).toEqual({ approved: ['card'], failed: [] });
  expect(Object.keys(manifestOf(root).baselines)).toEqual(['card']);
});

test('approve by base id does not re-approve a passing variant; its exact key still does', async () => {
  const root = project({ platform: 'urls', urls: [urls[0]] });
  runWith(root, [{ variant: 'dark', status: 'new' }]);
  expect(
    await approveCommand(
      { json: true, project: root, story: ['card__dark'] },
      { io: captureIo() },
    ),
  ).toBe(0);
  const before = manifestOf(root).baselines['card__dark'];

  // Next run: the variant now passes.
  rmSync(path.join(root, '.juxtapose', 'runs'), { recursive: true });
  runWith(root, [{ variant: 'dark', status: 'pass' }]);
  const io = captureIo();
  expect(
    await approveCommand({ json: true, project: root, story: ['card'] }, { io }),
  ).toBe(0);
  expect(JSON.parse(io.stdout())).toEqual({ approved: ['card'], failed: [] });
  expect(manifestOf(root).baselines['card__dark']).toEqual(before);

  const exact = captureIo();
  await approveCommand(
    { json: true, project: root, story: ['card__dark'] },
    { io: exact },
  );
  expect(JSON.parse(exact.stdout()).approved).toEqual(['card__dark']);
});

test('run prints each distinct warning once', async () => {
  const { eachOnce } = await import('./run.js');
  const out: string[] = [];
  const warn = eachOnce((m) => out.push(m));
  for (const m of ['a', 'b', 'a', 'b', 'c']) warn(m);
  expect(out).toEqual(['a', 'b', 'c']);
});

/** A run with exactly these results; an image for every non-skipped one. */
function runOf(root: string, results: Array<Record<string, string>>) {
  const run = path.join(root, '.juxtapose', 'runs', 'r1');
  rmSync(path.join(root, '.juxtapose', 'runs'), { recursive: true, force: true });
  mkdirSync(path.join(run, 'images'), { recursive: true });
  writeFileSync(path.join(run, 'report.json'), JSON.stringify({ runId: 'r1', results }));
  for (const r of results) {
    if (r['status'] === 'skip') continue;
    writeFileSync(
      path.join(run, 'images', `${encodeStoryId(r['storyId']!)}-current.webp`),
      Buffer.from(`${r['storyId']}:${r['status']}`),
    );
  }
}

test('a base id with variants applies the fan-out rule to its default too: a skipped default is left alone', async () => {
  const root = project({ platform: 'urls', urls: [urls[0]] });
  runOf(root, [
    { storyId: 'card', status: 'skip' },
    { storyId: 'card__dark', baseStoryId: 'card', variant: 'dark', status: 'fail' },
  ]);
  const io = captureIo();
  expect(
    await approveCommand({ json: true, project: root, story: ['card'] }, { io }),
  ).toBe(0);
  expect(JSON.parse(io.stdout())).toEqual({ approved: ['card__dark'], failed: [] });
  expect(Object.keys(manifestOf(root).baselines)).toEqual(['card__dark']);
});

test('a base id with variants does not re-approve its passing default', async () => {
  const root = project({ platform: 'urls', urls: [urls[0]] });
  runOf(root, [{ storyId: 'card', status: 'new' }]);
  await approveCommand(
    { json: true, project: root, story: ['card'] },
    { io: captureIo() },
  );
  const before = manifestOf(root).baselines['card'];

  runOf(root, [
    { storyId: 'card', status: 'pass' },
    { storyId: 'card__dark', baseStoryId: 'card', variant: 'dark', status: 'new' },
  ]);
  const io = captureIo();
  expect(
    await approveCommand({ json: true, project: root, story: ['card'] }, { io }),
  ).toBe(0);
  expect(JSON.parse(io.stdout()).approved).toEqual(['card__dark']);
  expect(manifestOf(root).baselines['card']).toEqual(before);

  // Without variants in the run, the id is an exact key: approved as asked.
  runOf(root, [{ storyId: 'card', status: 'pass' }]);
  const exact = captureIo();
  await approveCommand({ json: true, project: root, story: ['card'] }, { io: exact });
  expect(JSON.parse(exact.stdout()).approved).toEqual(['card']);
});
