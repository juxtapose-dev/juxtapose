import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { captureIo } from '../io.js';
import { doctorCommand, findIssues } from './doctor.js';

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'ignore' });

async function repo(files: Record<string, string>, config?: object): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-doctor-'));
  run(root, 'init', '-q');
  if (config)
    await writeFile(path.join(root, 'juxtapose.config.json'), JSON.stringify(config));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  run(root, 'add', '-f', '.');
  return root;
}

async function doctor(root: string, json = false) {
  const io = captureIo();
  const code = await doctorCommand({ project: root, json }, { io });
  return { code, out: io.stdout(), err: io.stderr() };
}

test('a clean project passes', async () => {
  const root = await repo({ '.gitignore': '.juxtapose/cache/\n.juxtapose/runs/\n' });
  const r = await doctor(root);
  expect(r.code).toBe(0);
  expect(r.out).toContain('ok');
});

test('tracked images in the old layout are reported with the exact migration', async () => {
  const root = await repo({
    '.juxtapose/baselines/a--b.webp': 'img',
    '.juxtapose/baselines/a--b.structure.json.gz': 'gz',
    '.gitignore': '.juxtapose/runs/\n',
  });
  const r = await doctor(root);
  expect(r.code).toBe(1);
  expect(r.out).toContain('1 baseline image is tracked');
  expect(r.out).toContain("git rm --cached -- '.juxtapose/baselines/*.webp'");
  // Structure sidecars are data CI still wants, so only images leave the index.
  expect(r.out).toContain('Structure sidecars');
  expect(r.out).toContain('.juxtapose/cache/');
});

test('--json lists the tracked files and the fix', async () => {
  const root = await repo({ '.juxtapose/baselines/a.webp': 'img' });
  const body = JSON.parse((await doctor(root, true)).out);
  expect(body.ok).toBe(false);
  expect(body.issues[0]).toMatchObject({
    code: 'tracked-images',
    files: ['.juxtapose/baselines/a.webp'],
    fix: expect.arrayContaining(["git rm --cached -- '.juxtapose/baselines/*.webp'"]),
  });
});

test('a project that chose the repo-backed store may track its images', async () => {
  const root = await repo(
    {
      '.juxtapose/baselines/a.webp': 'img',
      '.gitignore': '.juxtapose/runs/\n',
    },
    { storage: { kind: 'git' } },
  );
  expect((await doctor(root)).code).toBe(0);
});

test('a tracked file in the cache dir is reported too', async () => {
  const root = await repo({
    '.juxtapose/cache/baselines/abc.webp': 'img',
    '.gitignore': '.juxtapose/cache/\n.juxtapose/runs/\n',
  });
  const r = await doctor(root);
  expect(r.code).toBe(1);
  expect(r.out).toContain("git rm --cached -- '.juxtapose/cache/baselines/*.webp'");
});

test('missing ignore lines are reported with the lines to add', async () => {
  const root = await repo({ 'package.json': '{}' });
  const r = await doctor(root);
  expect(r.code).toBe(1);
  expect(r.out).toContain('.juxtapose/cache/');
  expect(r.out).toContain('.juxtapose/runs/');
});

// Fix commands are printed for an agent to run, and the directory comes from
// the repo's own config, so it must reach the shell as one literal argument.
const hostile = 'x\'; $(touch pwned) `id` "q" y';

test('a hostile storage.dir reaches the shell as a literal in every printed fix', async () => {
  const root = await repo({ [`${hostile}/a.webp`]: 'img' });
  const issues = await findIssues(root, { kind: 'cache', dir: hostile });
  const tracked = issues.find((i) => i.code === 'tracked-images')!;
  const rm = tracked.fix[0]!.replace(/^git rm --cached -- /, '');
  expect(execFileSync('sh', ['-c', `printf %s ${rm}`], { cwd: root }).toString()).toBe(
    `${hostile}/*.webp`,
  );
  const ignore = issues.find((i) => i.code === 'missing-ignores')!.fix[0]!;
  const args = /^printf '%s\\n' (.*) >> \.gitignore$/.exec(ignore)![1]!;
  expect(
    execFileSync('sh', ['-c', `printf '%s\\n' ${args}`], { cwd: root }).toString(),
  ).toBe(`${hostile}/\n.juxtapose/runs/\n`);
  expect(existsSync(path.join(root, 'pwned'))).toBe(false);
});

test('a storage.dir with a newline or control character is refused', async () => {
  const root = await repo({ 'package.json': '{}' });
  await expect(findIssues(root, { kind: 'cache', dir: 'a\nb' })).rejects.toThrow(
    /control characters/,
  );
  await expect(findIssues(root, { kind: 'git', dir: 'a\u0001b' })).rejects.toThrow();
});
