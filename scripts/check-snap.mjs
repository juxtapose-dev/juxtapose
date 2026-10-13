// End-to-end check for `jux snap`: a good page writes files and a structure;
// a 404 and an unreachable host exit 3 and write nothing; several urls share
// one browser, a failing page does not stop the rest, duplicate names are
// refused; a re-snap without
// structure removes the old sidecar; a zero viewport is a usage error.
// Run after `pnpm build`: node scripts/check-snap.mjs
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Async exec: execFileSync would block this process's event loop and the
// in-process server could never answer the child.
const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../packages/cli/dist/index.js');
const server = createServer((req, res) => {
  if (req.url === '/ok' || req.url === '/ok-two') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main><h1>Hello</h1><button>Save</button></main>');
  } else {
    res.writeHead(404);
    res.end('nope');
  }
}).listen(0);
const port = server.address().port;
const project = mkdtempSync(path.join(tmpdir(), 'jux-snap-'));
const run = async (args, env = {}, json = true) => {
  try {
    return {
      code: 0,
      out: (
        await exec(
          'node',
          [cli, 'snap', ...args, '--project', project, ...(json ? ['--json'] : [])],
          {
            encoding: 'utf8',
            env: { ...process.env, ...env },
          },
        )
      ).stdout,
    };
  } catch (e) {
    return { code: e.code, out: e.stdout + e.stderr };
  }
};
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const good = await run([`http://127.0.0.1:${port}/ok`, '--as', 'good']);
check(good.code === 0, 'good page exits 0');
const j = JSON.parse(good.out);
check(existsSync(j.image) && existsSync(j.structure), 'writes image and structure');
check(
  j.elements >= 3 && /^[0-9a-f]{64}$/.test(j.structureHash),
  'structure has elements and a hash',
);

// Re-snapping under the same name without structure must not leave the old
// sidecar beside the new pixels: a later diff would pair them.
const bare = await run([`http://127.0.0.1:${port}/ok`, '--as', 'good'], {
  JUXTAPOSE_NO_STRUCTURE: '1',
});
const jb = JSON.parse(bare.out);
check(
  bare.code === 0 && jb.structure === null && !existsSync(j.structure),
  're-snap without structure removes the previous sidecar',
);

const vp0 = await run([
  `http://127.0.0.1:${port}/ok`,
  '--as',
  'zero',
  '--viewport',
  '0x800',
]);
check(vp0.code === 2, 'a zero viewport dimension is a usage error (exit 2)');

const missing = await run([`http://127.0.0.1:${port}/missing`, '--as', 'missing']);
check(
  missing.code === 3 && /HTTP 404/.test(missing.out),
  '404 exits 3 naming the status',
);
check(
  !readdirSync(path.join(project, '.juxtapose/snaps')).some((f) =>
    f.startsWith('missing'),
  ),
  '404 writes nothing',
);

const down = await run(['http://127.0.0.1:1/', '--as', 'down']);
check(down.code === 3 && /could not capture/.test(down.out), 'unreachable host exits 3');

const noBrowser = await run([`http://127.0.0.1:${port}/ok`, '--as', 'nobrowser'], {
  PLAYWRIGHT_BROWSERS_PATH: '/nonexistent',
});
check(
  noBrowser.code === 3 &&
    /could not launch the browser/.test(noBrowser.out) &&
    /playwright install/.test(noBrowser.out),
  'no browser exits 3 and names the install command',
);

const file = await run(['file:///etc/passwd', '--as', 'file']);
check(
  file.code === 2 &&
    /not an http\(s\) URL/.test(file.out) &&
    !readdirSync(path.join(project, '.juxtapose/snaps')).some((f) =>
      f.startsWith('file'),
    ),
  'file: url is a usage error (2) and writes nothing',
);

// Several urls, one browser: each written to its own file under the prefix.
const multi = await run([
  `http://127.0.0.1:${port}/ok`,
  `http://127.0.0.1:${port}/ok-two`,
  '--as-prefix',
  'before',
]);
const jm = JSON.parse(multi.out);
check(
  multi.code === 0 &&
    jm.prefix === 'before' &&
    jm.snaps.length === 2 &&
    jm.snaps.every((s) => existsSync(s.image) && s.name.startsWith('before-')) &&
    jm.snaps[0].image !== jm.snaps[1].image,
  'multi-url snap writes every page to its own file under the prefix',
);

// One browser, one page, in sequence: a page captured second must be
// byte-identical to the same page captured alone, even with a mask and a
// wait-for in play (nothing carries over from the first page).
const flagsOn = ['--mask', 'button', '--wait-for', 'h1'];
const lead = await run([
  `http://127.0.0.1:${port}/ok`,
  `http://127.0.0.1:${port}/ok-two`,
  '--as-prefix',
  'seq',
  ...flagsOn,
]);
const alone = await run([`http://127.0.0.1:${port}/ok-two`, '--as', 'solo', ...flagsOn]);
const js = JSON.parse(lead.out);
const ja = JSON.parse(alone.out);
check(
  lead.code === 0 &&
    alone.code === 0 &&
    readFileSync(js.snaps[1].image).equals(readFileSync(ja.image)) &&
    js.snaps[1].structureHash === ja.structureHash,
  'a page captured second equals the same page captured alone (no state carries over)',
);

const dup = await run([
  `http://127.0.0.1:${port}/ok`,
  `http://127.0.0.1:${port}/ok/`,
  '--as-prefix',
  'dup',
]);
check(
  dup.code === 2 &&
    /would both be saved as 'dup-/.test(dup.out) &&
    /\/ok\//.test(dup.out) &&
    /trailing slash/.test(dup.out) &&
    !readdirSync(path.join(project, '.juxtapose/snaps')).some((f) => f.startsWith('dup')),
  'urls that slug to one name are refused (2) naming both, before any capture',
);

// A failing page in a set: the rest are captured and written, the failure is
// in the JSON with its error, and the exit is 3.
const mixed = await run([
  `http://127.0.0.1:${port}/ok`,
  `http://127.0.0.1:${port}/missing`,
  `http://127.0.0.1:${port}/ok-two`,
  '--as-prefix',
  'mixed',
]);
const mixedHuman = await run(
  [
    `http://127.0.0.1:${port}/ok`,
    `http://127.0.0.1:${port}/missing?a=1&b=2`,
    `http://127.0.0.1:${port}/ok-two`,
    '--as-prefix',
    'mixed',
    '--viewport',
    '390x844',
    '--mask',
    '.x',
    '--mask',
    '[data-a="it\'s"]',
  ],
  {},
  false,
);
const jx = JSON.parse(mixed.out.split('\n').find((l) => l.startsWith('{')));
check(
  mixed.code === 3 &&
    jx.snaps.length === 3 &&
    existsSync(jx.snaps[0].image) &&
    /HTTP 404/.test(jx.snaps[1].error) &&
    /2 of 3 pages written; 1 failed/.test(mixedHuman.out) &&
    mixedHuman.out.includes(
      `retry: jux snap 'http://127.0.0.1:${port}/missing?a=1&b=2' --as mixed-missing-a-1-b-2 --viewport 390x844 --mask .x --mask '[data-a="it'\\''s"]'`,
    ) &&
    existsSync(jx.snaps[2].image),
  'a failing page in a set exits 3, is reported with its error, and the others are written',
);

const stale = await run([`http://127.0.0.1:${port}/ok`, '--as-prefix', 'mixed']);
check(
  stale.code === 0 &&
    !readdirSync(path.join(project, '.juxtapose/snaps')).some((f) =>
      f.startsWith('mixed-ok-two'),
    ),
  'a re-run of a prefix removes its stale snaps',
);

const asMulti = await run([
  `http://127.0.0.1:${port}/ok`,
  `http://127.0.0.1:${port}/ok-two`,
  '--as',
  'one',
]);
check(
  asMulti.code === 2 && /--as-prefix/.test(asMulti.out),
  '--as with several urls is usage (2) pointing at --as-prefix',
);

server.close();
process.exit(failed ? 1 : 0);
