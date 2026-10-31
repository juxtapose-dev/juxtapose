import { createHash } from 'node:crypto';
import { access, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeStoryId, type RunReport } from '@juxtapose/core';
import { attachHostedDom } from './hosted-dom.js';
import { UserError } from './user-error.js';
import {
  readUploadProtocol,
  uploadVerifiedBatches,
  type ArtifactRef,
  type ArtifactRole,
  type BatchSnapshot,
} from './hosted-batch-upload.js';

export interface UploadConfig {
  origin: string;
  token: string;
}
export interface UploadResult {
  runId: string;
  reportUrl: string | null;
}
export interface AbandonSnapshot {
  storyIdSafe: string;
  attemptId: string;
}
export interface AbandonResult {
  runId: string;
  storyIdSafe: string;
  abandoned: true;
  cleanupPending: true;
}
export interface RecoverDirectResult {
  runId: string;
  attempts: AbandonSnapshot[];
}
const MAX_IMAGE = 1024 * 1024;
// A direct preparation can contain 32 signed URLs of up to 4 KiB each, plus descriptors and rows.
const MAX_CONTROL_RESPONSE = 256 * 1024;
const UPLOAD_WORKERS = 4;
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
      await response.body?.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new UserError(
        'Hosted upload refused a redirect. Local artifacts are retained.',
        1,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const hint =
        response.status === 401 || response.status === 403
          ? 'Check the project token and its permissions.'
          : 'Local artifacts are retained; retry with jux upload --run <directory>.';
      throw new UserError(`Hosted upload failed (HTTP ${response.status}). ${hint}`, 1);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new UserError('Hosted service returned an invalid response.', 1);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_CONTROL_RESPONSE)
          throw new UserError('Hosted service returned an invalid response.', 1);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof UserError) throw error;
      // The API may have committed before its response stream was lost.
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      throw new UserError(
        'Hosted upload lost its response. Local artifacts are retained; retry with jux upload --run <directory>.',
        1,
      );
    } finally {
      reader.releaseLock();
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new UserError('Hosted service returned an invalid response.', 1);
    }
  }
}

export function uploadRun(
  runDir: string,
  config: UploadConfig,
  onProgress?: (message: string) => void,
): Promise<UploadResult>;
export function uploadRun(
  runDir: string,
  config: UploadConfig,
  onProgress: ((message: string) => void) | undefined,
  abandon: AbandonSnapshot,
): Promise<AbandonResult>;
export function uploadRun(
  runDir: string,
  config: UploadConfig,
  onProgress: ((message: string) => void) | undefined,
  recover: { recoverOnly: true },
): Promise<RecoverDirectResult>;
export async function uploadRun(
  runDir: string,
  config: UploadConfig,
  onProgress?: (message: string) => void,
  recovery?: AbandonSnapshot | { recoverOnly: true },
): Promise<UploadResult | AbandonResult | RecoverDirectResult> {
  const abandon = recovery && 'attemptId' in recovery ? recovery : undefined;
  if (
    abandon &&
    (!/^[a-f0-9]{24}$/.test(abandon.storyIdSafe) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        abandon.attemptId,
      ))
  )
    throw new UserError('Invalid direct snapshot abandonment identity.');
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
    let contentHash = '0'.repeat(64);
    let hasDiff = false;
    // A skipped capture has no image evidence, even if a reused directory
    // contains files from a previous attempt.
    if (result.status !== 'skip' && !recovery) {
      try {
        await access(baselinePath);
        baselineHash = hash(await image(baselinePath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      contentHash = hash(await image(imagePath));
      if (result.hash !== undefined && result.hash !== contentHash)
        throw new UserError(
          'A run image no longer matches its report hash. Recapture before uploading.',
        );
      try {
        await access(diffPath);
        hasDiff = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (hasDiff) await image(diffPath);
    }
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
  if (
    abandon &&
    !snapshots.some((snapshot) => snapshot.storyIdSafe === abandon.storyIdSafe)
  )
    throw new UserError('The abandonment story does not belong to this local run.');
  const cliVersion = (
    JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
  onProgress?.(
    `jux: ${recovery ? 'resolving existing' : 'creating'} hosted run (${snapshots.length} snapshots)\n`,
  );
  const created = await request(
    config,
    '/v1/runs',
    'POST',
    JSON.stringify(
      recovery
        ? {
            runExternalId: `${hash(JSON.stringify(report)).slice(0, 32)}-${Date.parse(report.startedAt)}`,
            recoverOnly: true,
          }
        : {
            branch: report.branch,
            commitSha: report.commitSha,
            ...(await pullRequest(report)),
            affectedStoryIds: [...ids],
            storybookVersion: 'unknown',
            cliVersion,
            runExternalId: `${hash(JSON.stringify(report)).slice(0, 32)}-${Date.parse(report.startedAt)}`,
          },
    ),
  );
  if (
    typeof created.runId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      created.runId,
    ) ||
    typeof created.snapshotPutUrlTemplate !== 'string'
  )
    throw new UserError('Hosted service returned an invalid run response.', 1);
  const snapshotPutUrlTemplate = created.snapshotPutUrlTemplate;
  // These are explicit control-only commands. Their exact scoped routes remain
  // usable when incident response has disabled capability issuance/advertisement.
  if (recovery && !abandon) {
    const attempts: AbandonSnapshot[] = [];
    const route = `/v1/runs/${created.runId}/snapshots/direct/prepare`;
    const expectedAbandonPath = `/v1/runs/${created.runId}/snapshots/direct/abandon`;
    for (let offset = 0; offset < snapshots.length; offset += 16) {
      const items = snapshots
        .slice(offset, offset + 16)
        .map(({ storyIdSafe }) => ({ storyIdSafe }));
      const response = await request(
        config,
        route,
        'POST',
        JSON.stringify({ recoverOnly: true, items }),
      );
      const expected = new Set(items.map(({ storyIdSafe }) => storyIdSafe));
      if (
        response.schema !== 'juxtapose.snapshot-upload-preparation/v1' ||
        !Array.isArray(response.artifacts) ||
        response.artifacts.length !== 0 ||
        !Array.isArray(response.results) ||
        response.results.length !== expected.size
      )
        throw new UserError('The service returned invalid direct recovery evidence.');
      for (const raw of response.results) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new UserError('The service returned invalid direct recovery evidence.');
        const row = raw as Record<string, unknown>;
        if (typeof row.storyIdSafe !== 'string' || !expected.delete(row.storyIdSafe))
          throw new UserError('The service returned invalid direct recovery evidence.');
        if (
          row.recovery === undefined &&
          ((row.status === 200 &&
            typeof row.snapshotId === 'string' &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              row.snapshotId,
            ) &&
            typeof row.deduped === 'boolean') ||
            (row.status === 404 && row.error === 'upload_not_found') ||
            (row.status === 410 && row.error === 'upload_abandoned'))
        )
          continue;
        const detail = row.recovery;
        if (!detail || typeof detail !== 'object' || Array.isArray(detail))
          throw new UserError('The service returned invalid direct recovery evidence.');
        const value = detail as Record<string, unknown>;
        if (
          row.status !== 409 ||
          row.error !== 'snapshot_upload_pending' ||
          row.retryable !== false ||
          Object.keys(value).length !== 3 ||
          value.abandonPath !== expectedAbandonPath ||
          value.storyIdSafe !== row.storyIdSafe ||
          typeof value.attemptId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            value.attemptId,
          )
        )
          throw new UserError('The service returned invalid direct recovery evidence.');
        attempts.push({ storyIdSafe: row.storyIdSafe, attemptId: value.attemptId });
      }
    }
    return { runId: created.runId, attempts };
  }
  if (abandon) {
    const route = `/v1/runs/${created.runId}/snapshots/direct/abandon`;
    const response = await request(
      config,
      route,
      'POST',
      JSON.stringify({ items: [abandon] }),
    );
    if (!Array.isArray(response.results) || response.results.length !== 1)
      throw new UserError('The service returned an invalid abandonment receipt.');
    const result: unknown = response.results[0];
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new UserError('The service returned an invalid abandonment receipt.');
    const row = result as Record<string, unknown>;
    if (
      row.storyIdSafe !== abandon.storyIdSafe ||
      row.status !== 200 ||
      row.abandoned !== true ||
      row.cleanupPending !== true
    )
      throw new UserError(
        'The snapshot abandonment was not accepted. Local artifacts are retained.',
      );
    return {
      runId: created.runId,
      storyIdSafe: abandon.storyIdSafe,
      abandoned: true,
      cleanupPending: true,
    };
  }
  const protocol = readUploadProtocol(created.uploadProtocol, created.runId);
  let dedupedCount = 0;
  const uploadSnapshot = async (snapshot: (typeof snapshots)[number]) => {
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
    const uploaded = await request(
      config,
      snapshotPutUrlTemplate.replace('{storyIdSafe}', storyIdSafe),
      'PUT',
      form,
    );
    if (uploaded.deduped === true) dedupedCount++;
  };
  if (protocol) {
    const files = new Map<string, string>();
    const batch: BatchSnapshot[] = [];
    for (const snapshot of snapshots) {
      const { result } = snapshot;
      const artifacts: Partial<Record<ArtifactRole, ArtifactRef>> = {};
      const add = async (role: ArtifactRole, file: string, expected?: string) => {
        const bytes = await image(file),
          digest = hash(bytes);
        if (expected && digest !== expected)
          throw new UserError(
            'Run artifacts changed during upload; retry after capture completes.',
            1,
          );
        const ref = { hash: digest, bytes: bytes.length };
        artifacts[role] = ref;
        files.set(digest, file);
        return ref;
      };
      if (result.status !== 'skip') {
        artifacts.thumb = await add('current', snapshot.imagePath, snapshot.contentHash);
        if (snapshot.hasDiff) await add('diff', snapshot.diffPath);
        if (snapshot.baselineHash)
          await add('baseline', snapshot.baselinePath, snapshot.baselineHash);
      }
      batch.push({
        storyIdSafe: snapshot.storyIdSafe,
        meta: {
          storyId: result.storyId,
          status: result.status === 'skip' ? 'skipped' : result.status,
          mismatchPixels: result.mismatchPixels,
          mismatchPercent: result.mismatchPercent,
          durationMs: Math.round(result.durationMs),
          contentHash: snapshot.contentHash,
          ...(snapshot.baselineHash ? { baselineHash: snapshot.baselineHash } : {}),
        },
        artifacts,
      });
    }
    dedupedCount = await uploadVerifiedBatches(
      protocol,
      batch,
      async (ref) => {
        const file = files.get(ref.hash);
        if (!file)
          throw new UserError(
            'A batch artifact is unavailable. Local artifacts are retained.',
            1,
          );
        return image(file);
      },
      (route, body) => request(config, route, 'POST', body),
      onProgress,
    ).catch((error: unknown) => {
      if (protocol.direct && error instanceof UserError)
        throw new UserError(
          `${error.message} Inspect existing attempts without uploading with jux upload --run <directory> --recover-direct.`,
          error.exit,
        );
      throw error;
    });
  } else {
    let next = 0;
    let completed = 0;
    let failed = false;
    let failure: unknown;
    onProgress?.(
      `jux: uploading 0/${snapshots.length} snapshots (up to ${UPLOAD_WORKERS} at once)\n`,
    );
    const worker = async () => {
      while (!failed && next < snapshots.length) {
        const snapshot = snapshots[next++]!;
        try {
          await uploadSnapshot(snapshot);
          completed++;
          onProgress?.(`jux: uploaded ${completed}/${snapshots.length} snapshots\n`);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    };
    // Drain every in-flight request before returning a failure. A retry must not
    // race this attempt, and a partial upload must never reach finalization.
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_WORKERS, snapshots.length) }, worker),
    );
    if (failed) throw failure;
  }
  onProgress?.(`jux: finalizing hosted run (${snapshots.length} snapshots)\n`);
  const count = (status: string) =>
    snapshots.filter((s) => s.result.status === status).length;
  const finalReport = await attachHostedDom(
    {
      sourceReport: report,
      runId: created.runId,
      totalCount: snapshots.length,
      failCount: count('fail'),
      newCount: count('new'),
      skippedCount: count('skip'),
      dedupedCount,
      durationMs: Math.round(report.durationMs),
      snapshots: snapshots.map((s) => ({
        storyId: s.result.storyId,
        storyIdSafe: s.storyIdSafe,
        status: s.result.status === 'skip' ? 'skipped' : s.result.status,
        mismatchPercent: s.result.mismatchPercent,
        contentHash: s.result.status === 'skip' ? null : s.contentHash,
      })),
    },
    runDir,
    snapshots,
  );
  const finished = await request(
    config,
    `/v1/runs/${created.runId}/finalize`,
    'POST',
    JSON.stringify({
      report: finalReport,
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
  let handle;
  const invalid = () =>
    new UserError(
      'Hosted uploads require WebP images no larger than 1 MiB. Local artifacts are retained.',
    );
  try {
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE) throw invalid();
    // A file may grow after fstat. Never read or allocate beyond the bound to detect it.
    const buffer = Buffer.alloc(MAX_IMAGE + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_IMAGE) throw invalid();
    bytes = buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      'A run image is missing or unreadable. Recapture before uploading.',
    );
  } finally {
    await handle?.close().catch(() => {});
  }
  if (
    bytes.length > MAX_IMAGE ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  )
    throw invalid();
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
    if (!pr || ![pr.head?.sha, pr.merge_commit_sha].includes(report.commitSha)) return {};
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
