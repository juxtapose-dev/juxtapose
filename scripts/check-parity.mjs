#!/usr/bin/env node
// Record or compare per-story sha256 of a `jux run --all` on an example.
//   node scripts/check-parity.mjs record  examples/storybook out.json
//   node scripts/check-parity.mjs compare examples/storybook ref.json
// Add --daemon to capture through the warm browser; without it every run is a
// fresh launch (JUX_NO_DAEMON=1) and nothing is left idling.
// `record` on main (Playwright) then `compare` on this branch is the upgrade
// gate: every hash must match, or every user baseline turns red on upgrade.
// Exit 0 only when every recorded story matches.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const daemon = argv.includes('--daemon');
const [mode, exampleDir, file] = argv.filter((a) => a !== '--daemon');
const env = daemon ? process.env : { ...process.env, JUX_NO_DAEMON: '1' };
if (!['record', 'compare'].includes(mode) || !exampleDir || !file) {
  process.stderr.write(
    'usage: check-parity.mjs [--daemon] record|compare <exampleDir> <hashes.json>\n',
  );
  process.exit(2);
}
const dir = path.resolve(exampleDir);
const cli = path.resolve('packages/cli/dist/index.js');
await run('node', [cli, 'run', '--all'], { cwd: dir, env }).catch((e) => {
  if (!e.stdout) throw e; // a non-zero exit is normal when stories are new
});
const runs = path.join(dir, '.juxtapose', 'runs');
const latest = (await readdir(runs)).sort().at(-1);
const images = path.join(runs, latest, 'images');
const hashes = {};
for (const f of (await readdir(images)).sort()) {
  if (!f.endsWith('-current.webp')) continue;
  hashes[f.replace(/-current\.webp$/, '')] = createHash('sha256')
    .update(await readFile(path.join(images, f)))
    .digest('hex');
}
if (mode === 'record') {
  await writeFile(file, JSON.stringify(hashes, null, 1) + '\n');
  console.log(`recorded ${Object.keys(hashes).length} stories to ${file}`);
  process.exit(0);
}
const ref = JSON.parse(await readFile(file, 'utf8'));
let ok = 0;
const ids = Object.keys(ref);
for (const id of ids) {
  const same = ref[id] === hashes[id];
  if (same) ok++;
  console.log(
    `${same ? 'MATCH' : 'DIFF '} ${id} ${ref[id].slice(0, 12)} ${hashes[id]?.slice(0, 12) ?? '-'}`,
  );
}
console.log(`parity: ${ok}/${ids.length}`);
process.exit(ok === ids.length && ids.length > 0 ? 0 : 1);
