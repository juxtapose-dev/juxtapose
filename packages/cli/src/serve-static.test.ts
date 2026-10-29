import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { serveStatic } from './serve-static.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it('does not expose files through symlinks outside the build root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-static-security-'));
  dirs.push(root);
  const build = path.join(root, 'build');
  await mkdir(build);
  await writeFile(path.join(root, 'outside.txt'), 'SYNTHETIC-SECRET');
  await symlink(path.join(root, 'outside.txt'), path.join(build, 'leak.txt'));
  const server = await serveStatic(build);
  try {
    const response = await fetch(server.url + '/leak.txt');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('SYNTHETIC-SECRET');
  } finally {
    await server.close();
  }
});
it('a malformed URI returns 400 without killing the capture process', () => {
  const moduleUrl = new URL('./serve-static.ts', import.meta.url).href;
  const script = `import {serveStatic} from ${JSON.stringify(moduleUrl)};const server=await serveStatic(${JSON.stringify(tmpdir())});const response=await fetch(server.url+'/%');console.log(response.status);await server.close();`;
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(child.status).toBe(0);
  expect(child.stdout.trim()).toBe('400');
});

it('rejects a rebound host and cross-origin requests to private build files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-static-host-'));
  dirs.push(root);
  await writeFile(path.join(root, 'index.html'), 'PRIVATE-BUILD');
  const server = await serveStatic(root);
  try {
    expect(
      (
        await fetch(server.url, {
          headers: { host: 'attacker.invalid', origin: 'http://attacker.invalid' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(server.url, { headers: { origin: 'https://attacker.invalid' } }))
        .status,
    ).toBe(403);
  } finally {
    await server.close();
  }
});
it('rejects an escaping directory-index symlink but serves normal build assets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-static-index-'));
  dirs.push(root);
  await mkdir(path.join(root, 'build'));
  await mkdir(path.join(root, 'build', 'dir'));
  await writeFile(path.join(root, 'secret.html'), 'OUTSIDE');
  await symlink(
    path.join(root, 'secret.html'),
    path.join(root, 'build', 'dir', 'index.html'),
  );
  await writeFile(path.join(root, 'build', 'ok.js'), 'window.ok=true;');
  const server = await serveStatic(path.join(root, 'build'));
  try {
    expect((await fetch(server.url + '/dir/')).status).toBe(403);
    const response = await fetch(server.url + '/ok.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('window.ok=true;');
  } finally {
    await server.close();
  }
});
