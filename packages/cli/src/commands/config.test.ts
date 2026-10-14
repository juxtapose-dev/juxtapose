// `jux config --explain`: exit codes, the table, the JSON shape. The layer
// precedence itself is tested in core (capture/explain.test.ts); these go
// through the real CLI path on the urls platform, which needs no browser.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkArgs } from '../cli-args.js';
import { captureIo } from '../io.js';
import { closest } from '../suggest.js';
import { configCommand, format } from './config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noBrowser = () => Promise.reject(new Error('launched a browser'));

function project(config: object): string {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-config-'));
  dirs.push(root);
  writeFileSync(path.join(root, 'juxtapose.config.json'), JSON.stringify(config));
  return root;
}

const base = {
  platform: 'urls',
  settle: { timeout: 3000 },
  stories: { 'home*': { delay: 250 } },
  urls: [
    {
      id: 'home',
      url: 'http://127.0.0.1:1/',
      params: { delay: 10, viewport: { width: 900, height: 700 } },
      variants: {
        dark: { colorScheme: 'dark' },
        mobile: { extends: 'dark', viewport: { width: 375, height: 800 } },
      },
    },
    { id: 'about', url: 'http://127.0.0.1:1/about' },
  ],
};

async function run(
  config: object,
  flags: Parameters<typeof configCommand>[0],
): Promise<{ code: number; out: string; err: string }> {
  const io = captureIo();
  const code = await configCommand(
    { project: project(config), ...flags },
    { io, browser: noBrowser },
  );
  return { code, out: io.stdout(), err: io.stderr() };
}

test('prints a table of setting, value and source, naming matched globs', async () => {
  const r = await run(base, { explain: 'home' });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(
    /^home\nmatched stories globs: home\*\n\nSETTING +VALUE +SOURCE\n/,
  );
  expect(r.out).toMatch(/^delay +250 +stories\['home\*'\]$/m);
  expect(r.out).toMatch(/^viewport +900x700 +story parameters$/m);
  expect(r.out).toMatch(/^settle.timeout +3000 +project config$/m);
  expect(r.out).toMatch(/^settle.ready +false +default$/m);
});

test('a base id lists each variant key', async () => {
  const r = await run(base, { explain: 'home' });
  expect(r.out).toContain(
    'variants (jux config --explain <key>):\n  home__dark\n  home__mobile',
  );
});

test('a variant key names its extends chain and where each value came from', async () => {
  const r = await run(base, { explain: 'home__mobile' });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^home__mobile {2}\(variant mobile of home, extends dark\)/);
  expect(r.out).toMatch(/^viewport +375x800 +variant mobile \(story parameters\)$/m);
  expect(r.out).toMatch(
    /^colorScheme +dark +variant dark \(story parameters\), extended by mobile$/m,
  );
});

test('a CLI flag overrides the config', async () => {
  const r = await run(base, { explain: 'about', 'settle-timeout': '8000' });
  expect(r.out).toMatch(/^settle.timeout +8000 +CLI flag$/m);
});

test('shows the recheck mode and where it came from', async () => {
  const dflt = await run(base, { explain: 'about' });
  expect(dflt.out).toMatch(/^recheck +changed +default$/m);
  const proj = await run({ ...base, recheck: 'new' }, { explain: 'about' });
  expect(proj.out).toMatch(/^recheck +new +project config$/m);
  const flag = await run(
    { ...base, recheck: 'new' },
    { explain: 'about', recheck: 'off' },
  );
  expect(flag.out).toMatch(/^recheck +off +CLI flag$/m);
  const no = await run(base, { explain: 'about', 'no-recheck': true });
  expect(no.out).toMatch(/^recheck +off +CLI flag$/m);
  const bad = await run(base, { explain: 'about', recheck: 'sometimes' });
  expect(bad.code).toBe(2);
  expect(bad.err).toContain('--recheck must be changed, new, off');
});

test('an invalid flag value is a usage error', async () => {
  const r = await run(base, { explain: 'about', 'settle-timeout': 'soon' });
  expect(r.code).toBe(2);
  expect(r.err).toContain('--settle-timeout');
});

test('an unknown id exits 2 with a did-you-mean', async () => {
  const r = await run(base, { explain: 'hom__mobile' });
  expect(r.code).toBe(2);
  expect(r.out).toBe('');
  expect(r.err).toContain("no story or capture with id 'hom__mobile'");
  expect(r.err).toContain("Did you mean 'home__mobile'");
});

test('an unknown id with nothing close has no suggestion', async () => {
  const r = await run(base, { explain: 'zzzzzzzz' });
  expect(r.code).toBe(2);
  expect(r.err).not.toContain('Did you mean');
});

test('--json is the juxtapose.explain/v1 object', async () => {
  const r = await run(base, { explain: 'home__mobile', json: true });
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j).toMatchObject({
    schema: 'juxtapose.explain/v1',
    storyId: 'home__mobile',
    baseStoryId: 'home',
    variant: 'mobile',
    extends: ['dark'],
    skipped: false,
    matched: { stories: ['home*'], networkRules: [] },
    notes: [],
  });
  expect(j.settings).toContainEqual({
    setting: 'viewport',
    value: { width: 375, height: 800 },
    source: [{ layer: 'variant', detail: 'mobile (story parameters)' }],
  });
  expect(j.settings).toContainEqual({
    setting: 'settle.timeout',
    value: 3000,
    source: [{ layer: 'project' }],
  });
});

test('--json on a base id carries the variant keys', async () => {
  const j = JSON.parse((await run(base, { explain: 'home', json: true })).out);
  expect(j.variants).toEqual(['home__dark', 'home__mobile']);
});

test('without --explain there is nothing to do', async () => {
  const r = await run(base, {});
  expect(r.code).toBe(2);
  expect(r.err).toContain('--explain');
});

test('a config error exits 2', async () => {
  const r = await run(
    { ...base, urls: [{ ...base.urls[0], variants: { m: { extends: 'nope' } } }] },
    { explain: 'home' },
  );
  expect(r.code).toBe(2);
  expect(r.err).toContain("extends unknown variant 'nope'");
});

test('format shows a skipped capture and a note', () => {
  const out = format({
    schema: 'juxtapose.explain/v1',
    storyId: 'a',
    skipped: true,
    matched: { stories: [], networkRules: [] },
    settings: [],
    notes: ['careful'],
  });
  expect(out).toContain('skipped: this capture is not taken');
  expect(out).toContain('note: careful');
});

test('argument table: config takes --explain and settle flags, no positionals', () => {
  expect(
    checkArgs('config', { explain: 'a', 'settle-timeout': '5' }, []),
  ).toBeUndefined();
  expect(checkArgs('config', { explain: true }, [])).toContain('--explain needs a value');
  expect(checkArgs('config', { explain: 'a', all: true }, [])).toContain(
    'unknown option',
  );
  expect(checkArgs('config', { explain: 'a' }, ['b'])).toContain('unexpected argument');
});

test('closest ranks by edit distance and keeps the given order on ties', () => {
  expect(closest('btn', ['button', 'btn--a', 'btn'])).toEqual(['btn']);
  expect(closest('a', ['x', 'y'], 0)).toEqual([]);
});

test('network rules print in evaluation order with their layer; MCP arguments are labelled', async () => {
  const r = await run(
    {
      ...base,
      network: { external: 'block', rules: [{ match: '**/cdn/**', action: 'allow' }] },
      urls: [
        {
          ...base.urls[1],
          params: {
            network: { rules: [{ match: 'type:Image', action: 'placeholder' }] },
          },
        },
      ],
    },
    { explain: 'about', 'network-external': 'allow', callSource: 'mcp' },
  );
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^network.external.default +allow +MCP arguments$/m);
  expect(r.out).toContain(
    'network rules (first match wins):\n  placeholder type:Image  story parameters\n  allow       **/cdn/**  project config',
  );
});
