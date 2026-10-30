import { mkdtemp, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { packStorybook } from './build-archive.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'jux-build-'));
  dirs.push(dir);
  for (const name of ['index.html', 'iframe.html', 'index.json'])
    await writeFile(
      path.join(dir, name),
      name.endsWith('.json') ? '{}' : '<h1>Storybook</h1>',
    );
  return dir;
}
it('produces a portable archive unchanged by file timestamps', async () => {
  const dir = await fixture();
  const first = await packStorybook(dir);
  await utimes(path.join(dir, 'index.html'), 123456, 123456);
  expect(await packStorybook(dir)).toEqual(first);
  const archive = path.join(tmpdir(), `jux-${Date.now()}.tar.gz`);
  try {
    await writeFile(archive, first);
    expect(
      execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'),
    ).toEqual(['iframe.html', 'index.html', 'index.json']);
  } finally {
    await rm(archive, { force: true });
  }
});
it('refuses symlinks and missing Storybook entrypoints', async () => {
  const dir = await fixture();
  await symlink('/etc/passwd', path.join(dir, 'external'));
  await expect(packStorybook(dir)).rejects.toThrow(/symlink/i);
  await rm(path.join(dir, 'external'));
  await rm(path.join(dir, 'iframe.html'));
  await expect(packStorybook(dir)).rejects.toThrow(/iframe.html/);
});
it('refuses accidental credential files in a build directory', async () => {
  const dir = await fixture();
  await writeFile(path.join(dir, '.env'), 'secret');
  await expect(packStorybook(dir)).rejects.toThrow(/credential/i);
});
