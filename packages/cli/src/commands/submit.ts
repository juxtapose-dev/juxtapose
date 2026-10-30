import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommonFlags } from '../context.js';
import { stdio, type Io } from '../io.js';
import { UserError } from '../user-error.js';
import { uploadConfig } from '../hosted-upload.js';
import { packStorybook } from '../build-archive.js';
import { submitBuild } from '../managed-submit.js';
import { firstSymlink, writeFresh } from '../symlink-guard.js';

interface SubmitFlags extends CommonFlags {
  experimental?: boolean;
  branch?: string;
  pr?: string;
}
/** Upload-only while managed execution remains gated; never reports a passing visual check. */
export async function submitCommand(flags: SubmitFlags, io: Io = stdio): Promise<number> {
  if (flags.experimental !== true)
    throw new UserError(
      'Managed build submission is experimental. Use --experimental with an enabled service. Capture execution is not available yet.',
    );
  if (!flags['build-dir'])
    throw new UserError('jux submit needs --build-dir <compiled-storybook-directory>.');
  const config = uploadConfig();
  const root = path.resolve(flags.project ?? process.cwd());
  let sourceSha: string, localBranch: string;
  try {
    sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    localBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new UserError('Submit from a Git checkout with a committed HEAD.');
  }
  const branch =
    flags.branch ??
    process.env.GITHUB_HEAD_REF ??
    process.env.CI_COMMIT_REF_NAME ??
    localBranch;
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    branch === 'HEAD' ||
    !/^[\x20-\x7e]{1,200}$/.test(branch)
  )
    throw new UserError(
      'Submission needs a full source SHA and branch. For a detached checkout, provide --branch <name>.',
    );
  const prInput =
    flags.pr ??
    /^refs\/pull\/([1-9][0-9]*)\/(?:head|merge)$/.exec(process.env.GITHUB_REF ?? '')?.[1];
  const pullRequestNumber = prInput === undefined ? undefined : Number(prInput);
  if (
    prInput !== undefined &&
    (!/^[1-9][0-9]*$/.test(prInput) || !Number.isSafeInteger(pullRequestNumber))
  )
    throw new UserError('--pr must be a positive pull request number.');
  const archive = await packStorybook(path.resolve(root, flags['build-dir']));
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        config.origin,
        sourceSha,
        branch,
        pullRequestNumber ?? null,
        archiveSha256,
      ]),
    )
    .digest('hex');
  const segments = ['.juxtapose', 'managed-builds', `${key}.json`];
  if (await firstSymlink(root, segments))
    throw new UserError('Refusing to store build submission state through a symlink.');
  const stateFile = path.join(root, ...segments);
  let requestId = randomUUID();
  let expiresAt = Date.now() + 23 * 60 * 60 * 1000;
  try {
    const cached = JSON.parse(await readFile(stateFile, 'utf8')) as {
      requestId?: string;
      expiresAt?: number;
    };
    if (
      typeof cached.requestId === 'string' &&
      /^[a-f0-9-]{36}$/.test(cached.requestId) &&
      typeof cached.expiresAt === 'number' &&
      cached.expiresAt > Date.now() &&
      cached.expiresAt <= expiresAt
    ) {
      requestId = cached.requestId as typeof requestId;
      expiresAt = cached.expiresAt;
    }
  } catch {
    /* Missing or obsolete scratch metadata starts a new submission. */
  }
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFresh(stateFile, JSON.stringify({ requestId, expiresAt }));
  io.err(
    `jux: submitting ${(archive.length / 1024 / 1024).toFixed(2)} MiB compiled build (no local captures)\n`,
  );
  const result = await submitBuild(
    archive,
    {
      requestId,
      sourceSha,
      branch,
      ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
      archiveSha256,
      archiveBytes: archive.length,
    },
    config,
  );
  if (flags.json) io.out(`${JSON.stringify(result)}\n`);
  else
    io.out(
      `jux: build ${result.build.id} uploaded and byte-verified. Capture has not started; this is not a visual test result.\n`,
    );
  return 0;
}
