import type { UploadConfig } from './hosted-upload.js';
import { UserError } from './user-error.js';
import { DirectPutError, putDirect } from './direct-put.js';
export interface BuildMetadata {
  requestId: string;
  sourceSha: string;
  branch: string;
  pullRequestNumber?: number;
  archiveSha256: string;
  archiveBytes: number;
}
export interface BuildReceipt {
  build: {
    id: string;
    status: string;
    sourceSha: string;
    branch: string;
    pullRequestNumber?: number | null;
    archiveSha256: string;
    archiveBytes: number;
    captureStatus: string;
    sourceVerified: boolean;
    createdAt?: number;
    expiresAt?: number;
  };
  upload: { path: string; method: string; contentType: string };
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function request(
  config: UploadConfig,
  route: string,
  method: string,
  body: string | Buffer,
): Promise<unknown> {
  const url = new URL(route, config.origin);
  if (url.origin !== config.origin) throw new UserError('Invalid build upload origin.');
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        body: typeof body === 'string' ? body : new Uint8Array(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type':
            typeof body === 'string' ? 'application/json' : 'application/gzip',
        },
      });
    } catch {
      if (attempt < 2) continue;
      throw new UserError(
        'Build submission could not reach the service. Retry the same command; the request identity is retained.',
      );
    }
    if ([502, 503, 504].includes(response.status) && attempt < 2) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const hint =
        response.status === 404
          ? 'Managed capture intake is not enabled for this service.'
          : response.status === 401 || response.status === 403
            ? 'Check JUXTAPOSE_TOKEN and its ingest permission.'
            : response.status === 409
              ? 'An upload is in progress or this request conflicts; retry after the active upload finishes.'
              : response.status === 429
                ? 'Too many pending builds; retry after earlier builds complete.'
                : response.status === 410
                  ? 'The build receipt expired; start a new submission.'
                  : 'The build was not accepted; no visual result was produced.';
      throw new UserError(`Build submission failed (HTTP ${response.status}). ${hint}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new UserError('Invalid build receipt.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024) {
          await reader.cancel();
          throw new UserError('Invalid build receipt: response too large.');
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof UserError) throw error;
      if (attempt < 2) continue;
      throw new UserError(
        'Build submission lost its response. Retry the same command; the request identity is retained.',
      );
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new UserError('Invalid build receipt.');
    }
  }
}
function receipt(
  value: unknown,
  metadata: BuildMetadata,
  expectedId?: string,
): BuildReceipt {
  const parsed = value as BuildReceipt | null;
  const build = parsed?.build;
  const upload = parsed?.upload;
  if (
    !build ||
    typeof build.id !== 'string' ||
    !UUID.test(build.id) ||
    (expectedId && build.id !== expectedId) ||
    build.sourceSha !== metadata.sourceSha ||
    build.branch !== metadata.branch ||
    (build.pullRequestNumber ?? null) !== (metadata.pullRequestNumber ?? null) ||
    build.archiveSha256 !== metadata.archiveSha256 ||
    build.archiveBytes !== metadata.archiveBytes ||
    !['awaiting_upload', 'uploading', 'uploaded'].includes(build.status) ||
    build.captureStatus !== 'not_started' ||
    build.sourceVerified !== false ||
    [build.createdAt, build.expiresAt].some(
      (stamp) => stamp !== undefined && (!Number.isSafeInteger(stamp) || stamp < 0),
    ) ||
    upload?.path !== `/v1/builds/${build.id}/archive` ||
    upload.method !== 'PUT' ||
    upload.contentType !== 'application/gzip'
  )
    throw new UserError('Invalid build receipt.');
  // Never retain transient capabilities or unrecognized service fields in CLI receipts.
  return {
    build: {
      id: build.id,
      status: build.status,
      sourceSha: build.sourceSha,
      branch: build.branch,
      ...(build.pullRequestNumber === undefined
        ? {}
        : { pullRequestNumber: build.pullRequestNumber }),
      archiveSha256: build.archiveSha256,
      archiveBytes: build.archiveBytes,
      captureStatus: build.captureStatus,
      sourceVerified: build.sourceVerified,
      ...(build.createdAt === undefined ? {} : { createdAt: build.createdAt }),
      ...(build.expiresAt === undefined ? {} : { expiresAt: build.expiresAt }),
    },
    upload: { path: upload.path, method: upload.method, contentType: upload.contentType },
  };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function directPaths(value: unknown, id: string) {
  const upload = object(object(value)?.upload);
  if (!upload || !Object.hasOwn(upload, 'direct')) return undefined;
  const direct = object(upload.direct);
  const preparePath = `/v1/builds/${id}/archive/direct/prepare`;
  const finalizePath = `/v1/builds/${id}/archive/direct/finalize`;
  if (
    !direct ||
    Object.keys(direct).length !== 3 ||
    direct.schema !== 'juxtapose.archive-upload/v1' ||
    direct.preparePath !== preparePath ||
    direct.finalizePath !== finalizePath
  )
    throw new UserError('Invalid direct upload advertisement.');
  return { preparePath, finalizePath };
}
export async function submitBuild(
  archive: Buffer,
  metadata: BuildMetadata,
  config: UploadConfig,
): Promise<BuildReceipt> {
  const raw = await request(config, '/v1/builds', 'POST', JSON.stringify(metadata));
  const created = receipt(raw, metadata);
  const direct = directPaths(raw, created.build.id);
  if (created.build.status === 'uploaded') return created;
  if (direct) {
    const prepared = await request(config, direct.preparePath, 'POST', '{}');
    const ready = receipt(prepared, metadata, created.build.id);
    if (ready.build.status === 'uploaded') return ready;
    const session = object(object(prepared)?.directUpload);
    if (
      ready.build.status !== 'uploading' ||
      !session ||
      Object.keys(session).length !== 3 ||
      session.schema !== 'juxtapose.archive-upload-session/v1' ||
      typeof session.attemptId !== 'string' ||
      !UUID.test(session.attemptId) ||
      !Object.hasOwn(session, 'descriptor')
    )
      throw new UserError('Invalid direct upload session.');
    try {
      await putDirect(session.descriptor, archive, 'application/gzip');
    } catch (error) {
      // A lost PUT response can conceal success. Only the API can settle the attempt.
      if (!(error instanceof DirectPutError) || error.reason === 'invalid') throw error;
    }
    const accepted = receipt(
      await request(
        config,
        direct.finalizePath,
        'POST',
        JSON.stringify({ attemptId: session.attemptId }),
      ),
      metadata,
      created.build.id,
    );
    if (accepted.build.status !== 'uploaded')
      throw new UserError('The archive upload is incomplete. Retry the same command.');
    return accepted;
  }
  const uploaded = receipt(
    await request(config, created.upload.path, 'PUT', archive),
    metadata,
    created.build.id,
  );
  if (uploaded.build.status !== 'uploaded')
    throw new UserError('The archive upload is incomplete. Retry the same command.');
  return uploaded;
}
