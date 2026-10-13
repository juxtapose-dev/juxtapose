// End-to-end check for `jux diff`: identical snaps exit 0; a mutated page
// exits 1 with the expected classification; a missing snap or a missing name
// is a usage error that names the next command; a snap without a sidecar
// degrades to `no-baseline-structure`; the JSON is byte-identical across two
// runs; and the command works with no browser installed at all.
// Run after `pnpm build`: node scripts/check-diff.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCorpusServer } from './structural-corpus/server.mjs';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../packages/cli/dist/index.js');
const probe = path.resolve(import.meta.dirname, 'structural-corpus/no-playwright.mjs');
const project = mkdtempSync(path.join(tmpdir(), 'jux-diff-'));
const server = await startCorpusServer();
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const jux = async (args, env = {}) => {
  try {
    const r = await exec('node', [cli, ...args, '--project', project], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
};
const snap = (op, name, env) =>
  jux(['snap', `${server.url}/op/${op}`, '--as', name, '--json'], env);

await snap('noop', 'before');
await snap('noop', 'same');
await snap('color', 'after');
await snap('padding', 'padded');
await snap('color', 'bare', { JUXTAPOSE_NO_STRUCTURE: '1' });

const same = await jux(['diff', 'before', 'same', '--json']);
check(
  same.code === 0 && JSON.parse(same.out).classification === 'identical',
  'identical snaps exit 0',
);

// No browser, and no browser DRIVER: the probe makes loading playwright a
// crash (exit 3), so exit 1 here proves the import never happened.
const noBrowser = await jux(['diff', 'before', 'after', '--json'], {
  PLAYWRIGHT_BROWSERS_PATH: '/nonexistent',
  NODE_OPTIONS: `--import ${probe}`,
});
check(noBrowser.code === 1, 'different snaps exit 1 without loading playwright');
const probeWorks = await jux(['snap', `${server.url}/op/noop`, '--as', 'probe'], {
  NODE_OPTIONS: `--import ${probe}`,
});
check(
  probeWorks.code === 3 && /no-playwright probe/.test(probeWorks.err),
  'the probe itself fires for a command that does load playwright',
);

// Paths work as well as names.
const byPath = await jux([
  'diff',
  path.join(project, '.juxtapose/snaps/before.webp'),
  path.join(project, '.juxtapose/snaps/after.webp'),
  '--json',
]);
// The escalate command echoes the refs as typed, so compare the evidence.
const strip = (out) => ({ ...JSON.parse(out), escalate: null });
check(
  byPath.code === 1 &&
    JSON.stringify(strip(byPath.out)) === JSON.stringify(strip(noBrowser.out)),
  '.webp paths give the same verdict as names',
);
const v = JSON.parse(noBrowser.out);
check(
  v.schema === 'juxtapose.verdict/v1' && v.classification === 'style-only',
  'verdict is versioned and classified',
);
check(
  v.deltas.some((d) => d.kind === 'style' && d.prop === 'color'),
  'verdict names the colour delta',
);
check(v.explained === 'full', 'colour change fully explains the pixels');

const again = await jux(['diff', 'before', 'after', '--json']);
check(again.out === noBrowser.out, 'JSON is byte-identical across runs');

const human = await jux(['diff', 'before', 'after']);
check(
  /style-only \(color\)/.test(human.out) &&
    /^ {2}button\[name="Save"\] color /m.test(human.out),
  'human output leads with the summary and lists deltas',
);

// Causes first: the padding change leads, not the `main resized` it caused.
const padded = await jux(['diff', 'before', 'padded']);
const body = padded.out.split('\n').slice(2).filter(Boolean);
check(
  body[0].trim() === 'button[name="Save"]' &&
    body[1].trim().startsWith('padding ') &&
    /^next: jux diff before padded --crops/m.test(padded.out),
  'human output lists the cause first and ends with next:',
);

const bare = await jux(['diff', 'before', 'bare', '--json']);
const vb = JSON.parse(bare.out);
check(
  bare.code === 1 &&
    vb.flags.includes('no-current-structure') &&
    /re-snap/.test(vb.summary),
  'a side without a sidecar degrades and says how to fix it',
);

const missing = await jux(['diff', 'before', 'nope']);
check(
  missing.code === 2 &&
    /no snap named 'nope'/.test(missing.err) &&
    /jux snap <url> --as nope/.test(missing.err),
  'missing snap is usage (2) naming the fix',
);

const one = await jux(['diff', 'before']);
check(
  one.code === 2 && /jux snap <url> --as before/.test(one.err),
  'one argument is usage (2) with the next command',
);

// The verdict's own `next:` command must work: until crops exist it names
// the two images and succeeds.
const crops = await jux(['diff', 'before', 'after', '--crops']);
check(
  crops.code === 0 &&
    /^open these to compare; crops arrive in a later release\n {2}\S*before\.webp\n {2}\S*after\.webp\n$/.test(
      crops.out,
    ),
  '--crops names both images to open and exits 0',
);

// A name that needs quoting is quoted in the command a hint prints.
const spaced = await jux(['diff', 'no such snap', 'before']);
check(
  spaced.code === 2 && /`jux snap <url> --as 'no such snap'`/.test(spaced.err),
  'a missing-snap hint quotes a name with spaces',
);

// Exit 3: inputs that exist but cannot be read are tool failures, never
// "different" — a script must not approve on them.
const snaps = path.join(project, '.juxtapose/snaps');
await snap('color', 'corrupt');
writeFileSync(path.join(snaps, 'corrupt.structure.json.gz'), 'not gzip');
const corrupt = await jux(['diff', 'before', 'corrupt', '--json']);
check(
  corrupt.code === 3 &&
    /cannot read .*corrupt\.structure\.json\.gz/.test(corrupt.err) &&
    /jux snap <url> --as corrupt/.test(corrupt.err),
  'an undecodable sidecar exits 3 naming the file and the fix',
);
writeFileSync(path.join(snaps, 'badimg.webp'), 'not an image');
const badimg = await jux(['diff', 'before', 'badimg', '--json']);
check(
  badimg.code === 3 && /cannot read .*badimg\.webp/.test(badimg.err),
  'an undecodable image exits 3',
);

// An unexpected throw is exit 3 with a hint; JUX_DEBUG adds the stack.
// `handoff` with no workbench throws; the top-level handler reports it.
const dir = path.join(project, '.juxtapose/snaps');
writeFileSync(path.join(dir, 'x.webp'), 'x');
const crash = await exec('node', [cli, 'handoff', 'x', '--project', project], {
  encoding: 'utf8',
}).then(
  (r) => ({ code: 0, err: r.stderr }),
  (e) => ({ code: e.code, err: e.stderr }),
);
const crashDebug = await exec('node', [cli, 'handoff', 'x', '--project', project], {
  encoding: 'utf8',
  env: { ...process.env, JUX_DEBUG: '1' },
}).then(
  (r) => ({ code: 0, err: r.stderr }),
  (e) => ({ code: e.code, err: e.stderr }),
);
check(
  crash.code === 3 &&
    /JUX_DEBUG=1/.test(crash.err) &&
    !/\n\s+at /.test(crash.err) &&
    /\n\s+at /.test(crashDebug.err),
  'an unexpected throw exits 3 with a hint; JUX_DEBUG=1 adds the stack',
);

const typo = await exec('node', [cli, 'dif']).then(
  () => ({ code: 0, err: '' }),
  (e) => ({ code: e.code, err: e.stderr }),
);
check(
  typo.code === 2 && /Did you mean 'diff'\?/.test(typo.err),
  'an unknown command exits 2 and suggests the near match',
);

const noFile = await jux(['diff', path.join(dir, 'ghost.webp'), 'before']);
check(
  noFile.code === 2 && /no file at .*ghost\.webp/.test(noFile.err),
  'a missing .webp path says no file at <path>',
);

// --prefix: pair by slug, verdict each page, list the unpaired (Review Focus 4).
// Before: three pages. Then the "edit": /op/color now serves the padding page
// and /op/padding is not snapped again, so after = one identical, one changed,
// one missing.
const base = `${server.url}/op`;
await jux([
  'snap',
  `${base}/noop`,
  `${base}/color`,
  `${base}/padding`,
  '--as-prefix',
  'p1',
]);
server.serveAs('color', 'padding');
await jux(['snap', `${base}/noop`, `${base}/color`, '--as-prefix', 'p2']);
const set = await jux(['diff', '--prefix', 'p1', 'p2', '--json']);
const vs = JSON.parse(set.out);
const bySlug = Object.fromEntries(vs.pages.map((p) => [p.slug.replace(/^op-/, ''), p]));
check(
  set.code === 1 &&
    vs.schema === 'juxtapose.verdict-set/v1' &&
    vs.pages.length === 2 &&
    bySlug.noop.verdict.classification === 'identical' &&
    bySlug.color.verdict.classification !== 'identical' &&
    vs.missing.length === 1 &&
    vs.missing[0].slug === 'op-padding' &&
    vs.missing[0].want.startsWith('p2-') &&
    vs.summary.identical === 1 &&
    vs.summary.different === 1 &&
    vs.summary.missing === 1,
  '--prefix verdicts the paired pages and lists the unpaired one',
);
const human2 = await jux(['diff', '--prefix', 'p1', 'p2']);
check(
  /^3 pages: 1 changed, 1 identical; missing p2: op-padding\n/.test(human2.out) &&
    /no p2-op-padding\. A changed host or path.*--as-prefix p2.*--as p2-op-padding/.test(
      human2.out,
    ) &&
    human2.out.indexOf('changed') < human2.out.indexOf('next: jux diff p1-'),
  '--prefix human output leads with the page summary and says which snap to take',
);
// An all-identical set is clean (0).
await jux(['snap', `${base}/noop`, '--as-prefix', 'q1']);
await jux(['snap', `${base}/noop`, '--as-prefix', 'q2']);
const clean = await jux(['diff', '--prefix', 'q1', 'q2']);
check(
  clean.code === 0 && /^1 page: 1 identical\n/.test(clean.out),
  'an all-identical --prefix set exits 0',
);
const noset = await jux(['diff', '--prefix', 'zz', 'yy']);
check(
  noset.code === 2 && /--as-prefix zz/.test(noset.err),
  'unknown prefixes are usage (2) with the next command',
);

// A dev server that restarts on another port between before and after must
// still pair: slugs are path-based, not origin-based.
const server2 = await startCorpusServer();
await jux([
  'snap',
  `${server.url}/op/noop`,
  `${server.url}/op/padding`,
  '--as-prefix',
  'pa',
]);
await jux([
  'snap',
  `${server2.url}/op/noop`,
  `${server2.url}/op/padding`,
  '--as-prefix',
  'pb',
]);
const ported = await jux(['diff', '--prefix', 'pa', 'pb', '--json']);
const vp = JSON.parse(ported.out);
check(
  ported.code === 0 && vp.pages.length === 2 && vp.missing.length === 0,
  'before and after on different ports pair by path',
);
console.log(
  `     ${server.url} vs ${server2.url}: ${vp.pages.length} paired, ${vp.missing.length} missing`,
);
server2.close();
const nested = await jux(['diff', '--prefix', 'pa', 'pa-x']);
check(
  nested.code === 2 && /overlap/.test(nested.err),
  'overlapping prefixes are usage (2) saying why',
);
// An unreadable pair is reported for its slug and the rest still verdict.
writeFileSync(path.join(snaps, 'pb-op-padding.structure.json.gz'), 'not gzip');
const partial = await jux(['diff', '--prefix', 'pa', 'pb', '--json']);
const vq = JSON.parse(partial.out);
check(
  partial.code === 3 &&
    vq.pages.length === 1 &&
    vq.errors.length === 1 &&
    vq.errors[0].slug === 'op-padding' &&
    vq.errors[0].code === 'sidecar-undecodable' &&
    vq.errors[0].file === 'pb-op-padding.structure.json.gz' &&
    Object.keys(vq.errors[0]).join() === 'slug,code,file' &&
    vq.summary.errored === 1,
  'one unreadable pair is an error entry, the rest still verdict, exit 3',
);

// Both images pass the magic-number check and one still fails to decode: the
// decoder cannot say which, so the entry names no file.
copyFileSync(path.join(snaps, 'before.webp'), path.join(snaps, 'pc-x.webp'));
writeFileSync(
  path.join(snaps, 'pd-x.webp'),
  Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(64)]),
);
const pair = await jux(['diff', '--prefix', 'pc', 'pd', '--json']);
const vp2 = JSON.parse(pair.out || '{}');
check(
  pair.code === 3 &&
    JSON.stringify(vp2.errors) === '[{"slug":"x","code":"pair-undecodable","file":null}]',
  'an undecodable pair neither side owns is pair-undecodable with file null',
);

server.close();
rmSync(project, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
