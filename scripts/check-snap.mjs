// End-to-end check for `jux snap`: a good page writes files and a structure;
// a 404 and an unreachable host exit 3 and write nothing; a re-snap without
// structure removes the old sidecar; a zero viewport is a usage error.
// Run after `pnpm build`: node scripts/check-snap.mjs
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Async exec: execFileSync would block this process's event loop and the
// in-process server could never answer the child.
const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../packages/cli/dist/index.js');
const server = createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main><h1>Hello</h1><button>Save</button></main>');
  } else {
    res.writeHead(404);
    res.end('nope');
  }
}).listen(0);
const port = server.address().port;
const project = mkdtempSync(path.join(tmpdir(), 'jux-snap-'));
const run = async (args, env = {}) => {
  try {
    return {
      code: 0,
      out: (
        await exec('node', [cli, 'snap', ...args, '--project', project, '--json'], {
          encoding: 'utf8',
          env: { ...process.env, ...env },
        })
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

const file = await run(['file:///etc/passwd', '--as', 'file']);
check(
  file.code === 2 &&
    !readdirSync(path.join(project, '.juxtapose/snaps')).some((f) =>
      f.startsWith('file'),
    ),
  'file: url is a usage error (2) and writes nothing',
);

server.close();
process.exit(failed ? 1 : 0);
