import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeStoryId, type RunReport } from '@juxtapose/core';
import { UserError } from './user-error.js';

export interface UploadConfig {
  origin: string;
  token: string;
}
export interface UploadResult {
  runId: string;
  reportUrl: string | null;
}
const MAX_IMAGE = 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function uploadConfig(env = process.env): UploadConfig {
  const token = env.JUXTAPOSE_TOKEN?.trim();
  if (!token || /[\r\n]/.test(token))
    throw new UserError(
      'Hosted upload needs a project-scoped JUXTAPOSE_TOKEN environment variable.',
    );
  let url: URL;
  try {
    url = new URL(env.JUXTAPOSE_API_URL ?? 'https://api.juxtapose.dev');
  } catch {
    throw new UserError('JUXTAPOSE_API_URL must be an HTTPS origin.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new UserError(
      'JUXTAPOSE_API_URL must be an HTTPS origin (HTTP is allowed only on loopback).',
    );
  return { origin: url.origin, token };
}

async function request(
  config: UploadConfig,
  route: string,
  method: string,
  body: string | FormData,
): Promise<Record<string, unknown>> {
  const url = new URL(route, config.origin);
  if (url.origin !== config.origin || url.username || url.password)
    throw new UserError('Hosted service returned an unsafe upload URL.');
  // Stable external run identity and immutable snapshot/finalize bodies make retries idempotent.
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${config.token}`,
          ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
        },
      });
    } catch {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      throw new UserError(
        'Hosted upload could not reach the service (timeout, network error, or redirect). Local artifacts are retained; retry with jux upload --run <directory>.',
        1,
      );
    }
    if (attempt < 2 && [502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      continue;
    }
    if (response.status >= 300 && response.status < 400)
      throw new UserError(
        'Hosted upload refused a redirect. Local artifacts are retained.',
        1,
      );
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? 'Check the project token and its permissions.'
          : 'Local artifacts are retained; retry with jux upload --run <directory>.';
      throw new UserError(`Hosted upload failed (HTTP ${response.status}). ${hint}`, 1);
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new UserError('Hosted service returned an invalid response.', 1);
    }
  }
}

export async function uploadRun(
  runDir: string,
  config: UploadConfig,
): Promise<UploadResult> {
  let report: RunReport;
  try {
    report = JSON.parse(
      await readFile(path.join(runDir, 'report.json'), 'utf8'),
    ) as RunReport;
  } catch {
    throw new UserError('Cannot read report.json from the selected run directory.');
  }
  if (
    !report ||
    typeof report.runId !== 'string' ||
    !Array.isArray(report.results) ||
    !report.results.length ||
    report.results.length > 50_000 ||
    typeof report.branch !== 'string' ||
    !report.branch ||
    report.branch.length > 200 ||
    !/^[\x20-\x7e]+$/.test(report.branch) ||
    !/^[a-f0-9]{40}$/i.test(report.commitSha) ||
    !Number.isFinite(report.durationMs) ||
    report.durationMs < 0 ||
    !Number.isFinite(Date.parse(report.startedAt))
  )
    throw new UserError(
      'Run report is invalid, empty, or has no Git commit. Capture a committed project before uploading.',
    );
  if (Buffer.byteLength(JSON.stringify(report)) > 5 * 1024 * 1024)
    throw new UserError('Hosted report evidence exceeds the 5 MiB limit.');
  const ids = new Set<string>();
  // Validate all artifacts before creating any remote run. Do not hold the suite's images in memory.
  const snapshots: {
    result: RunReport['results'][number];
    imagePath: string;
    diffPath: string;
    hasDiff: boolean;
    baselinePath: string;
    baselineHash?: string;
    contentHash: string;
    storyIdSafe: string;
  }[] = [];
  for (const result of report.results) {
    if (
      !result ||
      typeof result.storyId !== 'string' ||
      !result.storyId ||
      result.storyId.length > 200 ||
      !/^[\x20-\x7e]+$/.test(result.storyId) ||
      ids.has(result.storyId) ||
      !['pass', 'fail', 'new', 'stale', 'skip'].includes(result.status) ||
      (result.error &&
        !(
          result.error === 'viewport size changed since baseline' &&
          typeof result.hash === 'string'
        )) ||
      !Number.isInteger(result.mismatchPixels) ||
      result.mismatchPixels < 0 ||
      !Number.isFinite(result.mismatchPercent) ||
      result.mismatchPercent < 0 ||
      result.mismatchPercent > 100 ||
      !Number.isFinite(result.durationMs) ||
      result.durationMs < 0
    )
      throw new UserError(
        'Run contains invalid, duplicate, unsupported, or errored captures. Fix capture errors and rerun before uploading.',
      );
    ids.add(result.storyId);
    const imagePath = path.join(
      runDir,
      'images',
      `${encodeStoryId(result.storyId)}-current.webp`,
    );
    const diffPath = path.join(
      runDir,
      'images',
      `${encodeStoryId(result.storyId)}-diff.webp`,
    );
    const baselinePath = path.join(
      runDir,
      'images',
      `${encodeStoryId(result.storyId)}-baseline.webp`,
    );
    let baselineHash: string | undefined;
    try {
      await readFile(baselinePath);
      baselineHash = hash(await image(baselinePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let contentHash = '0'.repeat(64);
    if (result.status !== 'skip') {
      contentHash = hash(await image(imagePath));
      if (result.hash !== undefined && result.hash !== contentHash)
        throw new UserError(
          'A run image no longer matches its report hash. Recapture before uploading.',
        );
    }
    let hasDiff = false;
    try {
      await readFile(diffPath);
      hasDiff = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (hasDiff) await image(diffPath);
    snapshots.push({
      result,
      imagePath,
      diffPath,
      hasDiff,
      baselinePath,
      ...(baselineHash ? { baselineHash } : {}),
      contentHash,
      storyIdSafe: hash(result.storyId).slice(0, 24),
    });
  }
  const cliVersion = (
    JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
  const created = await request(
    config,
    '/v1/runs',
    'POST',
    JSON.stringify({
      branch: report.branch,
      commitSha: report.commitSha,
      ...(await pullRequest(report)),
      affectedStoryIds: [...ids],
      storybookVersion: 'unknown',
      cliVersion,
      runExternalId: `${hash(JSON.stringify(report)).slice(0, 32)}-${Date.parse(report.startedAt)}`,
    }),
  );
  if (
    typeof created.runId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(created.runId) ||
    typeof created.snapshotPutUrlTemplate !== 'string'
  )
    throw new UserError('Hosted service returned an invalid run response.', 1);
  for (const snapshot of snapshots) {
    const { result, contentHash, storyIdSafe } = snapshot;
    const form = new FormData();
    form.set(
      'meta',
      JSON.stringify({
        storyId: result.storyId,
        status: result.status === 'skip' ? 'skipped' : result.status,
        mismatchPixels: result.mismatchPixels,
        mismatchPercent: result.mismatchPercent,
        durationMs: Math.round(result.durationMs),
        contentHash,
        ...(snapshot.baselineHash ? { baselineHash: snapshot.baselineHash } : {}),
      }),
    );
    if (result.status !== 'skip') {
      const current = await image(snapshot.imagePath);
      if (hash(current) !== contentHash)
        throw new UserError(
          'Run artifacts changed during upload; retry after capture completes.',
          1,
        );
      form.set(
        'current',
        new Blob([new Uint8Array(current)], { type: 'image/webp' }),
        'current.webp',
      );
      form.set(
        'thumb',
        new Blob([new Uint8Array(current)], { type: 'image/webp' }),
        'thumb.webp',
      );
      if (snapshot.hasDiff)
        form.set(
          'diff',
          new Blob([new Uint8Array(await image(snapshot.diffPath))], {
            type: 'image/webp',
          }),
          'diff.webp',
        );
    }
    if (snapshot.baselineHash) {
      const baseline = await image(snapshot.baselinePath);
      if (hash(baseline) !== snapshot.baselineHash)
        throw new UserError('Baseline artifact changed during upload.', 1);
      form.set(
        'baseline',
        new Blob([new Uint8Array(baseline)], { type: 'image/webp' }),
        'baseline.webp',
      );
    }
    await request(
      config,
      created.snapshotPutUrlTemplate.replace('{storyIdSafe}', storyIdSafe),
      'PUT',
      form,
    );
  }
  const count = (status: string) =>
    snapshots.filter((s) => s.result.status === status).length;
  const finished = await request(
    config,
    `/v1/runs/${created.runId}/finalize`,
    'POST',
    JSON.stringify({
      report: {
        sourceReport: report,
        runId: created.runId,
        totalCount: snapshots.length,
        failCount: count('fail'),
        newCount: count('new'),
        skippedCount: count('skip'),
        dedupedCount: 0,
        durationMs: Math.round(report.durationMs),
        snapshots: snapshots.map((s) => ({
          storyId: s.result.storyId,
          storyIdSafe: s.storyIdSafe,
          status: s.result.status === 'skip' ? 'skipped' : s.result.status,
          mismatchPercent: s.result.mismatchPercent,
          contentHash: s.result.status === 'skip' ? null : s.contentHash,
        })),
      },
    }),
  );
  if (finished.reportUrl === null) return { runId: created.runId, reportUrl: null };
  if (typeof finished.reportUrl !== 'string')
    throw new UserError('Hosted service returned an invalid review response.', 1);
  let review: URL;
  try {
    review = new URL(finished.reportUrl);
  } catch {
    throw new UserError('Hosted service returned an invalid review URL.', 1);
  }
  if (
    !['https:', 'http:'].includes(review.protocol) ||
    review.username ||
    review.password
  )
    throw new UserError('Hosted service returned an unsafe review URL.', 1);
  return { runId: created.runId, reportUrl: review.href };
}

async function image(file: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new UserError(
      'A run image is missing or unreadable. Recapture before uploading.',
    );
  }
  if (
    bytes.length > MAX_IMAGE ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  )
    throw new UserError(
      'Hosted uploads require WebP images no larger than 1 MiB. Local artifacts are retained.',
    );
  return bytes;
}

async function pullRequest(
  report: RunReport,
): Promise<{ prNumber?: number; branch?: string }> {
  if (
    !process.env.GITHUB_EVENT_PATH ||
    !['pull_request', 'pull_request_target'].includes(process.env.GITHUB_EVENT_NAME ?? '')
  )
    return {};
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) as {
      number?: number;
      pull_request?: { head?: { sha?: string; ref?: string }; merge_commit_sha?: string };
    };
    const pr = event.pull_request;
    // An older run retried in another job must not attach to that job's PR.
    if (
      !pr ||
      ![pr.head?.sha, pr.merge_commit_sha, process.env.GITHUB_SHA].includes(
        report.commitSha,
      )
    )
      return {};
    const branch = pr.head?.ref;
    return Number.isSafeInteger(event.number) && event.number! > 0
      ? {
          prNumber: event.number!,
          ...(report.branch === 'HEAD' &&
          branch &&
          branch.length <= 200 &&
          /^[\x20-\x7e]+$/.test(branch)
            ? { branch }
            : {}),
        }
      : {};
  } catch {
    throw new UserError(
      'Cannot read GitHub pull request metadata; verify GITHUB_EVENT_PATH.',
    );
  }
}

export function uploadMessage(result: UploadResult): string {
  return result.reportUrl
    ? `jux: hosted review ${result.reportUrl}\n`
    : `jux: uploaded run ${result.runId}. Link a GitHub repository to this project to open hosted review.\n`;
}
