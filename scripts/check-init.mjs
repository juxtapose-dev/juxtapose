// End-to-end regression check for issue #199: `jux init` must save structure
// for every baseline it approves, so the first failing `jux run` after setup
// gets a structural verdict instead of "no baseline structure".
//
// Initialises a throwaway project over a COPY of examples/storybook's built
// workbench, asserts every manifest entry references readable structure, then injects a
// style change into the copy and asserts the changed stories are explained
// structurally. Run after `pnpm build` and `pnpm --filter example-storybook build`:
//   node scripts/check-init.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CacheBaselineStore, decodeStructure } from '../packages/core/dist/index.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const built = path.join(root, 'examples/storybook/storybook-static');
if (!existsSync(cli)) throw new Error('built CLI not found: run `pnpm build` first');
if (!existsSync(built))
  throw new Error('example not built: run `pnpm --filter example-storybook build` first');

const tmp = mkdtempSync(path.join(tmpdir(), 'jux-init-'));
const project = path.join(tmp, 'project');
const stateDir = path.join(tmp, 'state');
const buildDir = path.join(tmp, 'storybook-static');
cpSync(built, buildDir, { recursive: true });
cpSync(
  path.join(root, 'examples/storybook/juxtapose.config.json'),
  path.join(tmp, 'seed.json'),
);
const seed = JSON.parse(readFileSync(path.join(tmp, 'seed.json'), 'utf8'));
await import('node:fs/promises').then((fs) => fs.mkdir(project, { recursive: true }));
writeFileSync(
  path.join(project, 'juxtapose.config.json'),
  JSON.stringify({ ...seed, buildDir, concurrency: 2 }, null, 2),
);

const env = { ...process.env, JUX_STATE_DIR: stateDir, JUX_NO_DAEMON: '1' };
const jux = (args) =>
  exec('node', [cli, ...args, '--project', project], {
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // Exit 1 means "needs review", not a crash.
  }).catch((e) => (e.stdout !== undefined ? e : Promise.reject(e)));

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const init = await jux(['init', '--json']);
const initOut = JSON.parse(init.stdout);
check(initOut.approved > 0, `init approved ${initOut.approved} baselines`);

const manifest = JSON.parse(
  readFileSync(path.join(project, 'juxtapose.manifest.json'), 'utf8'),
);
const entries = Object.entries(manifest.baselines ?? manifest.stories ?? {});
check(entries.length === initOut.approved, `manifest holds ${entries.length} entries`);
const store = new CacheBaselineStore({ projectRoot: project });
const bare = [];
for (const [id, entry] of entries) {
  if (
    typeof entry.structureFile !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.structureFileHash ?? '') ||
    !entry.structureHash
  ) {
    bare.push(id);
    continue;
  }
  // The store verifies the file checksum and reconstructs the full paths;
  // checking only a filename would miss broken or unreadable evidence.
  const bytes = await store.getStructure(id);
  try {
    const structure = bytes ? decodeStructure(bytes) : null;
    if (
      !structure ||
      structure.schema !== 'juxtapose.structure/v1' ||
      structure.structureHash !== entry.structureHash ||
      !Array.isArray(structure.elements)
    )
      bare.push(id);
  } catch {
    bare.push(id);
  }
}
check(
  bare.length === 0,
  `every entry has verified readable structure (missing: ${bare.slice(0, 5).join(', ') || 'none'})`,
);

// A real visual change in the built copy: every story that has a button or
// heading moves, so some stories fail and must be explained structurally.
const iframe = path.join(buildDir, 'iframe.html');
writeFileSync(
  iframe,
  readFileSync(iframe, 'utf8').replace(
    '</head>',
    '<style>button, h1, h2, h3 { font-size: 28px !important; }</style></head>',
  ),
);
const run = await jux(['run', '--all', '--json']);
const report = JSON.parse(run.stdout);
const results = report.results ?? [];
const changed = results.filter((r) => r.status === 'fail');
check(changed.length > 0, `${changed.length} stories fail after the change`);
const unexplained = changed.filter(
  (r) =>
    !r.structural ||
    r.structural.flags?.includes('no-baseline-structure') ||
    /no baseline structure/.test(r.structural.summary ?? ''),
);
check(
  unexplained.length === 0,
  `no failing story says "no baseline structure" (${unexplained.length} do)`,
);
check(
  changed.some((r) => (r.structural?.deltaCount ?? 0) > 0),
  'at least one failure carries structural deltas',
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed (temp project kept at ${tmp})`);
  process.exit(1);
}
