import type { UploadConfig } from './hosted-upload.js';
import { UserError } from './user-error.js';
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
    upload?.path !== `/v1/builds/${build.id}/archive` ||
    upload.method !== 'PUT' ||
    upload.contentType !== 'application/gzip'
  )
    throw new UserError('Invalid build receipt.');
  return parsed;
}
export async function submitBuild(
  archive: Buffer,
  metadata: BuildMetadata,
  config: UploadConfig,
): Promise<BuildReceipt> {
  const created = receipt(
    await request(config, '/v1/builds', 'POST', JSON.stringify(metadata)),
    metadata,
  );
  if (created.build.status === 'uploaded') return created;
  const uploaded = receipt(
    await request(config, created.upload.path, 'PUT', archive),
    metadata,
    created.build.id,
  );
  if (uploaded.build.status !== 'uploaded')
    throw new UserError('The archive upload is incomplete. Retry the same command.');
  return uploaded;
}
