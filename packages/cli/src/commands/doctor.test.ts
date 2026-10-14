import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeStructure, hashImage } from '@juxtapose/core';
import { expect, test } from 'vitest';
import { captureIo } from '../io.js';
import { doctorCommand, findIssues, globPathspec } from './doctor.js';

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
    '.gitignore': '.juxtapose/\n',
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
  expect(r.out).toContain("rm --cached -- ':(glob).juxtapose/baselines/*.webp'");
  // The cache must be filled before the commit deletes the files elsewhere.
  expect(r.out.indexOf('run --all')).toBeLessThan(r.out.indexOf('rm --cached'));
  // Structure moves into the manifest; the sidecars are a separate step.
  expect(r.out).toContain('legacy structure file');
  expect(r.out).toContain('.juxtapose/');
});

test('--json lists the tracked files and the fix', async () => {
  const root = await repo({ '.juxtapose/baselines/a.webp': 'img' });
  const body = JSON.parse((await doctor(root, true)).out);
  expect(body.ok).toBe(false);
  expect(body.issues[0]).toMatchObject({
    code: 'tracked-images',
    files: ['.juxtapose/baselines/a.webp'],
    fix: expect.arrayContaining([
      expect.stringContaining("rm --cached -- ':(glob).juxtapose/baselines/*.webp'"),
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
    '.gitignore': '.juxtapose/runs/\n',
  });
  const r = await doctor(root);
  expect(r.code).toBe(1);
  expect(r.out).toContain("rm --cached -- ':(glob).juxtapose/cache/baselines/*.webp'");
});

test('missing ignore lines are reported with the lines to add', async () => {
  const root = await repo({ 'package.json': '{}' });
  const r = await doctor(root);
  expect(r.code).toBe(1);
  // One line covers everything machine-local.
  expect(r.out).toContain('.juxtapose/');
  expect(r.out).not.toContain('.juxtapose/runs/');
});

// Fix commands are printed for an agent to run, and the directory comes from
// the repo's own config, so it must reach the shell as one literal argument.
const hostile = 'x\'; $(touch pwned) `id` "q" y';

test('a hostile storage.dir reaches the shell as a literal in every printed fix', async () => {
  const root = await repo({ [`${hostile}/a.webp`]: 'img' });
  const issues = await findIssues(root, { kind: 'cache', dir: hostile }, root);
  const tracked = issues.find((i) => i.code === 'tracked-images')!;
  const rm = tracked.fix[0]!.replace(/^GIT_LITERAL_PATHSPECS=0 git rm --cached -- /, '');
  expect(tracked.fix[0]).toMatch(/^GIT_LITERAL_PATHSPECS=0 git rm --cached -- /);
  expect(execFileSync('sh', ['-c', `printf %s ${rm}`], { cwd: root }).toString()).toBe(
    `:(glob)${hostile}/*.webp`,
  );
  const ignore = issues.flatMap((i) => i.fix).find((l) => l.includes('>> '))!;
  const args = /^printf '%s\\n' (.*) >> \.gitignore$/.exec(ignore)![1]!;
  expect(
    execFileSync('sh', ['-c', `printf '%s\\n' ${args}`], { cwd: root }).toString(),
  ).toBe(`.juxtapose/\n${hostile}/\n${hostile}.tmp/\n`);
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
  // Images are gone; the legacy sidecar stays until a run has folded its
  // structure into the manifest, so doctor still asks for that step.
  const left = await findIssues(root, undefined, root);
  expect(left.map((i) => i.code)).toEqual(['legacy-sidecars']);
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  expect(files).toContain('a.structure.json.gz');
  expect(files).not.toContain('.webp');
  for (const line of left[0]!.fix.filter((l) => !l.startsWith('jux '))) {
    execFileSync('sh', ['-c', line], { cwd: root, stdio: 'ignore' });
  }
  expect(await findIssues(root, undefined, root)).toEqual([]);
  expect(
    execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }),
  ).not.toContain('structure.json.gz');
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

test('one .juxtapose/ line covers everything machine-local', async () => {
  const root = await repo({ '.gitignore': '.juxtapose/\n' });
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

test('an ignore that hides the manifest is reported, with no rewrite offered', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-doctor-'));
  run(root, 'init', '-q');
  await writeFile(path.join(root, '.gitignore'), '.juxtapose/\n*.json\n');
  await writeFile(path.join(root, 'juxtapose.manifest.json'), '{}');
  const hidden = (await findIssues(root, undefined, root)).find(
    (i) => i.code === 'committed-paths-ignored',
  )!;
  expect(hidden.message).toContain('juxtapose.manifest.json');
  expect(hidden.message).toContain('by hand');
  expect(hidden.fix).toEqual([]);
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

// The printed rm names the directory's glob characters literally, and `*` still
// means "any file name" only inside it.
test('globPathspec untracks the named directory only, even if its name is a glob', async () => {
  const root = await repo({
    'a[1]/x.webp': 'i',
    'a1/x.webp': 'i',
    'a[1]/deep/y.webp': 'i',
    'a[1]/keep.txt': 'i',
  });
  execFileSync('sh', ['-c', `git rm -q --cached -- ${globPathspec('a[1]', '.webp')}`], {
    cwd: root,
  });
  const left = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
  expect(left).toEqual(['a1/x.webp', 'a[1]/deep/y.webp', 'a[1]/keep.txt']);
});

// ---- legacy sidecars: fold into the manifest without approving anything ----

const legacyImage = Buffer.from('legacy-image');
const sidecarSnapshot = {
  schema: 'juxtapose.structure/v1' as const,
  viewport: { width: 10, height: 10 },
  structureHash: 'e'.repeat(64),
  contentHeight: 10,
  elements: [],
};

/** A v1 project with two stories whose legacy images and sidecars are on disk:
 *  `ok` matches its manifest hash, `moved` does not (its image changed). */
async function legacyProject(): Promise<{ root: string; manifest: string }> {
  const root = await repo({ '.gitignore': '.juxtapose/\n' });
  const dir = path.join(root, '.juxtapose/baselines');
  await mkdir(dir, { recursive: true });
  const gz = encodeStructure(sidecarSnapshot);
  await writeFile(path.join(dir, 'ok.webp'), legacyImage);
  await writeFile(path.join(dir, 'ok.structure.json.gz'), gz);
  await writeFile(path.join(dir, 'moved.webp'), 'now-different');
  await writeFile(path.join(dir, 'moved.structure.json.gz'), gz);
  const meta = { commit: 'c', approvedBy: 'a', approvedAt: 't' };
  const manifest =
    JSON.stringify(
      {
        version: 1,
        baselines: {
          moved: { ...meta, hash: 'd'.repeat(64) },
          ok: { ...meta, hash: hashImage(legacyImage) },
        },
      },
      null,
      2,
    ) + '\n';
  await writeFile(path.join(root, 'juxtapose.manifest.json'), manifest);
  run(root, 'add', '-f', '.');
  return { root, manifest };
}

test("doctor's legacy-sidecar fix never tells anyone to approve", async () => {
  const { root } = await legacyProject();
  const issue = (await findIssues(root, undefined, root)).find(
    (i) => i.code === 'legacy-sidecars',
  )!;
  expect(issue.fix.join('\n')).not.toContain('approve');
  expect(issue.fix).toContain('jux doctor --fix');
  const r = await doctor(root);
  expect(r.out).not.toContain('approve');
});

test('doctor --fix folds matching sidecars into the manifest, approving and capturing nothing', async () => {
  const { root, manifest } = await legacyProject();
  const io = captureIo();
  await doctorCommand({ project: root, fix: true }, { io });
  expect(io.stderr()).toContain('folded structure into 1 manifest entry');
  expect(io.stderr()).toContain('moved');

  const after = JSON.parse(
    await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8'),
  );
  const before = JSON.parse(manifest);
  // Still version 1, so an older jux still reads it.
  expect(after.version).toBe(1);
  // Same stories, same hashes: a failing story is still failing.
  expect(Object.keys(after.baselines)).toEqual(Object.keys(before.baselines));
  for (const id of Object.keys(before.baselines)) {
    expect(after.baselines[id].hash).toBe(before.baselines[id].hash);
    expect(after.baselines[id].approvedAt).toBe('t');
  }
  expect(after.baselines.ok.structure).toBeDefined();
  expect(after.baselines.moved.structure).toBeUndefined();
  // No run happened and none was needed.
  expect(existsSync(path.join(root, '.juxtapose/runs'))).toBe(false);
});

const CONFLICTED =
  '{\n<<<<<<< HEAD\n  "version": 1,\n=======\n  "version": 1,\n>>>>>>> m\n}\n';

test('doctor --fix leaves a manifest with conflict markers alone', async () => {
  const root = await repo({ '.gitignore': '.juxtapose/\n' });
  await writeFile(path.join(root, 'juxtapose.manifest.json'), CONFLICTED);
  const io = captureIo();
  const code = await doctorCommand({ project: root, fix: true }, { io });
  expect(code).toBe(1);
  expect(await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8')).toBe(
    CONFLICTED,
  );
});

test('doctor reports manifest conflict markers with the lockfile guidance', async () => {
  const root = await repo({ '.gitignore': '.juxtapose/\n' });
  await writeFile(path.join(root, 'juxtapose.manifest.json'), CONFLICTED);
  const r = await doctor(root);
  expect(r.code).toBe(1);
  expect(r.out).toContain("Don't hand-merge");
  const body = JSON.parse((await doctor(root, true)).out);
  expect(body.issues[0].code).toBe('manifest-conflict');
});

// A shell that exports GIT_LITERAL_PATHSPECS=1 makes git read `:(glob)` as part
// of a name, so the printed commands switch it off for themselves.
test('printed git commands with pathspec magic work when GIT_LITERAL_PATHSPECS=1 is exported', async () => {
  const root = await repo({
    '.juxtapose/baselines/a.webp': 'i',
    '.juxtapose/baselines/a.structure.json.gz': 'g',
    '.gitignore': '.juxtapose/runs/\n',
  });
  const issues = await findIssues(root, undefined, root);
  const lines = issues
    .flatMap((i) => i.fix)
    .filter((l) => l.includes('git rm') && l.includes(':(glob)'));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l.startsWith('GIT_LITERAL_PATHSPECS=0 ')).toBe(true);
  for (const l of lines) {
    execFileSync('sh', ['-c', l], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    });
  }
  const left = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  expect(left).not.toContain('a.webp');
  expect(left).not.toContain('structure.json.gz');
});

test('globPathspec escapes a backslash in the directory, which :(glob) reads as an escape', async () => {
  const root = await repo({
    'a\\b/x.webp': 'i',
    'ab/x.webp': 'i',
  });
  execFileSync('sh', ['-c', `git rm -q --cached -- ${globPathspec('a\\b', '.webp')}`], {
    cwd: root,
  });
  const left = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  expect(left).toEqual(['ab/x.webp']);
});
