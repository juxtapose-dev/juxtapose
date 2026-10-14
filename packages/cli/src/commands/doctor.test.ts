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
  const root = await repo({
    '.gitignore':
      '.juxtapose/cache/\n.juxtapose/tmp/\n.juxtapose/baselines/*.webp\n.juxtapose/runs/\n',
  });
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
  expect(r.out).toContain("rm --cached -- '.juxtapose/baselines/*.webp'");
  // The cache must be filled before the commit deletes the files elsewhere.
  expect(r.out.indexOf('run --all')).toBeLessThan(r.out.indexOf('rm --cached'));
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
    fix: expect.arrayContaining([
      expect.stringContaining("rm --cached -- '.juxtapose/baselines/*.webp'"),
    ]),
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
  expect(r.out).toContain("rm --cached -- '.juxtapose/cache/baselines/*.webp'");
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
  const issues = await findIssues(root, { kind: 'cache', dir: hostile }, root);
  const tracked = issues.find((i) => i.code === 'tracked-images')!;
  const rm = tracked.fix[0]!.replace(/^git rm --cached -- /, '');
  expect(tracked.fix[0]).toMatch(/^git rm --cached -- /);
  expect(execFileSync('sh', ['-c', `printf %s ${rm}`], { cwd: root }).toString()).toBe(
    `${hostile}/*.webp`,
  );
  const ignore = issues.flatMap((i) => i.fix).find((l) => l.includes('>> '))!;
  const args = /^printf '%s\\n' (.*) >> \.gitignore$/.exec(ignore)![1]!;
  expect(
    execFileSync('sh', ['-c', `printf '%s\\n' ${args}`], { cwd: root }).toString(),
  ).toBe(`${hostile}/\n${hostile}.tmp/\n.juxtapose/baselines/*.webp\n.juxtapose/runs/\n`);
  expect(existsSync(path.join(root, 'pwned'))).toBe(false);
});

test('a storage.dir with a newline or control character is refused', async () => {
  const root = await repo({ 'package.json': '{}' });
  await expect(findIssues(root, { kind: 'cache', dir: 'a\nb' })).rejects.toThrow(
    /control characters/,
  );
  await expect(findIssues(root, { kind: 'git', dir: 'a\u0001b' })).rejects.toThrow();
});

test('commands work from another directory: git -C and an absolute .gitignore, quoted', async () => {
  const root = await repo({ '.juxtapose/baselines/a.webp': 'img' });
  const issues = await findIssues(root, undefined, tmpdir());
  const text = issues.flatMap((i) => i.fix).join('\n');
  expect(text).toContain(`git -C ${root} rm --cached --`);
  expect(text).toContain(`>> ${path.join(root, '.gitignore')}`);
});

// Following the printed commands must leave the repo clean and doctor happy.
test('the full migration: run its fix commands, then nothing is untracked and doctor is ok', async () => {
  const root = await repo({
    '.juxtapose/baselines/a.webp': 'img',
    '.juxtapose/baselines/b.webp': 'img2',
    '.juxtapose/baselines/a.structure.json.gz': 'gz',
    'juxtapose.manifest.json': '{"version":1,"baselines":{}}',
  });
  run(root, 'config', 'user.email', 'a@b.c');
  run(root, 'config', 'user.name', 't');
  const issues = await findIssues(root, undefined, root);
  const tracked = issues.find((i) => i.code === 'tracked-images')!;
  // `jux run` needs a workbench; the rest is what a person would paste.
  for (const line of tracked.fix.filter((l) => !l.startsWith('jux '))) {
    execFileSync('sh', ['-c', line], { cwd: root, stdio: 'ignore' });
  }
  const status = execFileSync('git', ['status', '--porcelain', '-uall'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(status).not.toMatch(/\?\? .*\.webp/);
  expect(await findIssues(root, undefined, root)).toEqual([]);
  // The structure sidecar stayed tracked.
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  expect(files).toContain('a.structure.json.gz');
  expect(files).not.toContain('.webp');
});

test('untracked, un-ignored images are flagged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-doctor-'));
  run(root, 'init', '-q');
  await mkdir(path.join(root, '.juxtapose/baselines'), { recursive: true });
  await writeFile(path.join(root, '.juxtapose/baselines/a.webp'), 'img');
  const codes = (await findIssues(root, undefined, root)).map((i) => i.code);
  expect(codes).toContain('untracked-images');
  // Its fix carries the ignore lines, so they are not listed twice.
  expect(codes).not.toContain('missing-ignores');
});

test('a broader pattern that leaves the committed files visible counts as covered', async () => {
  const root = await repo({ '.gitignore': '.juxtapose/*\n!.juxtapose/structure/\n' });
  expect(await findIssues(root, undefined, root)).toEqual([]);
});

test('storage.dir outside the project works for fs, and a bad cache dir is a usage error', async () => {
  const fsRoot = await repo(
    { 'package.json': '{}', '.gitignore': '.juxtapose/runs/\n' },
    { storage: { kind: 'fs', dir: '../shared-baselines' } },
  );
  expect((await doctor(fsRoot)).code).toBe(0);
  const bad = await repo(
    { 'package.json': '{}' },
    { storage: { kind: 'cache', dir: '../x' } },
  );
  await expect(
    doctorCommand({ project: bad }, { io: captureIo() }),
  ).rejects.toMatchObject({
    name: 'UserError',
    exit: 2,
  });
});

test('a broad .juxtapose/ ignore hides the committed files; the printed fix really re-includes them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-doctor-'));
  run(root, 'init', '-q');
  await mkdir(path.join(root, '.juxtapose/structure'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.juxtapose/\n');
  await writeFile(path.join(root, '.juxtapose/structure/x.structure.json'), '{}');
  await writeFile(path.join(root, 'juxtapose.manifest.json'), '{}');

  const issues = await findIssues(root, undefined, root);
  const hidden = issues.find((i) => i.code === 'committed-paths-ignored')!;
  expect(hidden.message).toContain('.juxtapose/structure/x.structure.json');

  // Without the fix, git add skips the sidecar.
  expect(() =>
    execFileSync('git', ['add', '--', '.juxtapose/structure/x.structure.json'], {
      cwd: root,
      stdio: 'ignore',
    }),
  ).toThrow();

  for (const line of hidden.fix) {
    execFileSync('sh', ['-c', line], { cwd: root, stdio: 'ignore' });
  }
  execFileSync('git', ['add', '--', '.juxtapose/structure/x.structure.json'], {
    cwd: root,
    stdio: 'ignore',
  });
  // Images, the cache and runs stay ignored, and doctor is satisfied.
  for (const p of [
    '.juxtapose/cache/baselines/a.webp',
    '.juxtapose/runs/r/report.json',
  ]) {
    run(root, 'check-ignore', '-q', '--', p);
  }
  expect(
    (await findIssues(root, undefined, root)).filter(
      (i) => i.code === 'committed-paths-ignored',
    ),
  ).toEqual([]);
});

test('an ignore from somewhere other than the project .gitignore is reported without a rewrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-doctor-'));
  run(root, 'init', '-q');
  await writeFile(path.join(root, '.git/info/exclude'), 'juxtapose.manifest.json\n');
  const hidden = (await findIssues(root, undefined, root)).find(
    (i) => i.code === 'committed-paths-ignored',
  )!;
  expect(hidden.fix).toEqual([]);
  expect(hidden.message).toContain('by hand');
});
