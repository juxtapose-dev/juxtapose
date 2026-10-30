import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommonFlags } from '../context.js';
import { stdio, type Io } from '../io.js';
import { UserError } from '../user-error.js';
import { uploadConfig, type UploadConfig } from '../hosted-upload.js';
import { packStorybook } from '../build-archive.js';
import { submitBuild, type BuildReceipt } from '../managed-submit.js';
import {
  waitForManagedBuild,
  resumeManagedBuild,
  ManagedWaitError,
} from '../managed-wait.js';
import { EXIT } from '../exit-codes.js';
import { firstSymlink, writeFresh } from '../symlink-guard.js';

interface SubmitFlags extends CommonFlags {
  experimental?: boolean;
  branch?: string;
  pr?: string;
  wait?: boolean;
  resume?: string;
  'wait-timeout'?: string;
  'poll-interval'?: string;
}
/** Upload-only by default; explicit waiting uses the hosted workflow without starting a local browser. */
export async function submitCommand(flags: SubmitFlags, io: Io = stdio): Promise<number> {
  if (flags.experimental !== true)
    throw new UserError(
      'Managed build submission is experimental. Use --experimental with an enabled service; --wait requires hosted execution.',
    );
  const numeric = (
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
    name: string,
  ) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
      throw new UserError(
        `${name} must be a whole number of milliseconds between ${min} and ${max}.`,
      );
    return n;
  };
  if (
    !flags.wait &&
    !flags.resume &&
    (flags['wait-timeout'] !== undefined || flags['poll-interval'] !== undefined)
  )
    throw new UserError('Wait timing flags require --wait.');
  const timeoutMs = numeric(
    flags['wait-timeout'],
    30 * 60_000,
    1000,
    3 * 60 * 60_000,
    '--wait-timeout',
  );
  const pollMs = numeric(flags['poll-interval'], 2000, 250, 30000, '--poll-interval');
  if (flags['review-in-github'] && !flags.wait && !flags.resume)
    throw new UserError('--review-in-github requires --wait or --resume.');
  const config = uploadConfig();
  if (flags.resume) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(flags.resume)
    )
      throw new UserError('--resume must be a build UUID.');
    if (flags['build-dir'] || flags.branch || flags.pr || flags.project)
      throw new UserError(
        '--resume cannot be combined with local build or source arguments.',
      );
    return completeManagedWait(flags, io, config, null, flags.resume, timeoutMs, pollMs);
  }
  if (!flags['build-dir'])
    throw new UserError('jux submit needs --build-dir <compiled-storybook-directory>.');

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
  if (flags.wait)
    return completeManagedWait(
      flags,
      io,
      config,
      result,
      result.build.id,
      timeoutMs,
      pollMs,
    );
  if (flags.json) io.out(`${JSON.stringify(result)}\n`);
  else
    io.out(
      `jux: build ${result.build.id} uploaded and byte-verified. Capture has not started; this is not a visual test result.\n`,
    );
  return 0;
}

async function completeManagedWait(
  flags: SubmitFlags,
  io: Io,
  config: UploadConfig,
  result: BuildReceipt | null,
  buildId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<number> {
  const controller = new AbortController(),
    interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    let progress = '';
    const options = {
      requireGithubDelivery: flags['review-in-github'] === true,
      timeoutMs,
      pollMs,
      signal: controller.signal,
      onProgress: (status: import('../managed-wait.js').ManagedStatus) => {
        const next = `${status.phase}:${status.reason ?? ''}`;
        if (next !== progress) {
          progress = next;
          io.err(
            `jux: hosted ${status.phase}${status.reason ? ` (${status.reason})` : ''}\n`,
          );
        }
      },
    };
    const workflow = await (result
      ? waitForManagedBuild(result, config, options)
      : resumeManagedBuild(buildId, config, options));
    const handoff =
      flags['review-in-github'] === true &&
      workflow.review.state === 'ready' &&
      workflow.githubReview?.state === 'delivered';
    const code =
      workflow.phase === 'reference'
        ? EXIT.clean
        : workflow.review.state === 'ready'
          ? handoff || ['unchanged', 'approved'].includes(workflow.review.verdict)
            ? EXIT.clean
            : EXIT.review
          : workflow.recovery === 'capture_baseline'
            ? EXIT.review
            : EXIT.failure;
    if (flags.json)
      io.out(
        `${JSON.stringify({ ...(result ?? {}), buildId, workflow, ...(handoff ? { handoff: { status: 'published', reviewUrl: workflow.review.url, approval: 'required_app_check' } } : {}) })}\n`,
      );
    else if (workflow.phase === 'reference')
      io.out('jux: reference capture completed; this is not a PR review verdict.\n');
    else if (handoff)
      io.out(
        `jux: hosted review published; GitHub delivery is recorded. Require the Juxtapose App check for approval.\n${workflow.review.url}\n`,
      );
    else if (workflow.review.url)
      io.out(`jux: hosted review ${workflow.review.verdict}\n${workflow.review.url}\n`);
    else if (workflow.recovery === 'capture_baseline')
      io.out(
        'jux: exact ancestor baseline missing. Capture the default branch before branching, or rebase onto a captured default-branch commit, then retry. No baseline was approved.\n',
      );
    else
      io.out(
        `jux: hosted workflow stopped (${workflow.reason ?? 'incomplete'}); recovery: ${workflow.recovery}.\n`,
      );
    return code;
  } catch (error) {
    const failure =
      error instanceof ManagedWaitError
        ? error
        : new ManagedWaitError(
            'wait_failed',
            `Managed waiting failed for build ${buildId}; retry the same command.`,
          );
    if (flags.json)
      io.out(
        `${JSON.stringify({ ...(result ?? {}), buildId, workflow: failure.lastStatus, error: { code: failure.code, message: failure.message } })}\n`,
      );
    io.err(`jux: ${failure.message}\n`);
    return EXIT.failure;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
