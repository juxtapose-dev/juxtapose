import { createHash } from 'node:crypto';
import { UserError } from './user-error.js';
import { uploadDirectBatches, type DirectBatchProtocol } from './hosted-direct-batch.js';

export interface ArtifactRef {
  hash: string;
  bytes: number;
}
export type ArtifactRole = 'current' | 'thumb' | 'diff' | 'baseline' | 'review';
export interface BatchSnapshot {
  storyIdSafe: string;
  meta: {
    storyId: string;
    status: string;
    mismatchPixels: number;
    mismatchPercent: number;
    durationMs: number;
    contentHash: string;
    baselineHash?: string;
  };
  artifacts: Partial<Record<ArtifactRole, ArtifactRef>>;
}
export interface UploadProtocol {
  direct?: DirectBatchProtocol;
  version: 1;
  probePath: string;
  batchPath: string;
  maxItems: number;
  maxBlobs: number;
  maxRequestBytes: number;
  maxArtifactBytes: number;
  maxProbeItems: number;
}
type Send = (route: string, body: string | FormData) => Promise<Record<string, unknown>>;
type Batch = { items: BatchSnapshot[]; blobs: ArtifactRef[] };
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid = () =>
  new UserError(
    'Hosted service returned invalid batch upload evidence. Local artifacts are retained.',
    1,
  );
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function readUploadProtocol(raw: unknown, runId: string): UploadProtocol | null {
  // Only an absent advertisement means this is an older service. Auth, network,
  // malformed capability or receipt failures must never select another protocol.
  if (raw === undefined) return null;
  if (
    !object(raw) ||
    raw.version !== 1 ||
    raw.probePath !== `/v1/runs/${runId}/artifacts/probe` ||
    raw.batchPath !== `/v1/runs/${runId}/snapshots/batch`
  )
    throw invalid();
  const limit = (name: string, maximum: number) => {
    const value = raw[name];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value <= 0 ||
      value > maximum
    )
      throw invalid();
    return value;
  };
  const maxRequestBytes = limit('maxRequestBytes', 8 * 1024 * 1024);
  if (maxRequestBytes <= 128 * 1024) throw invalid();
  let direct: DirectBatchProtocol | undefined;
  if (Object.hasOwn(raw, 'direct')) {
    const value = raw.direct;
    if (
      !object(value) ||
      Object.keys(value).length !== (Object.hasOwn(value, 'abandonPath') ? 5 : 4) ||
      value.schema !== 'juxtapose.snapshot-upload/v1' ||
      value.preparePath !== `/v1/runs/${runId}/snapshots/direct/prepare` ||
      value.finalizePath !== `/v1/runs/${runId}/snapshots/direct/finalize` ||
      (Object.hasOwn(value, 'abandonPath') &&
        value.abandonPath !== `/v1/runs/${runId}/snapshots/direct/abandon`) ||
      typeof value.maxConcurrentPuts !== 'number' ||
      !Number.isInteger(value.maxConcurrentPuts) ||
      value.maxConcurrentPuts < 1 ||
      value.maxConcurrentPuts > 4
    )
      throw invalid();
    direct = {
      schema: value.schema,
      preparePath: value.preparePath,
      finalizePath: value.finalizePath,
      maxConcurrentPuts: value.maxConcurrentPuts,
      ...(typeof value.abandonPath === 'string'
        ? { abandonPath: value.abandonPath }
        : {}),
    };
  }
  return {
    ...(direct ? { direct } : {}),
    version: 1,
    probePath: raw.probePath,
    batchPath: raw.batchPath,
    maxItems: limit('maxItems', 16),
    maxBlobs: limit('maxBlobs', 32),
    maxRequestBytes,
    maxArtifactBytes: limit('maxArtifactBytes', 1024 * 1024),
    maxProbeItems: limit('maxProbeItems', 256),
  };
}

function artifactRefs(item: BatchSnapshot): ArtifactRef[] {
  return Object.values(item.artifacts).filter(
    (ref): ref is ArtifactRef => ref !== undefined,
  );
}
function partition(
  items: BatchSnapshot[],
  available: Set<string>,
  forced: Set<string>,
  protocol: UploadProtocol,
): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { items: [], blobs: [] };
  let hashes = new Set<string>(),
    bytes = 0;
  // Leave bounded space for the <=64KiB manifest, <=32 fixed-format multipart
  // headers and boundaries. Never serialize an unbounded request to size it.
  const budget = protocol.direct
    ? Infinity // Direct control requests contain refs only; individual PUTs remain bounded.
    : Math.min(7 * 1024 * 1024, protocol.maxRequestBytes - 128 * 1024);
  for (const item of items) {
    const needed = new Map(
      artifactRefs(item)
        .filter((ref) => forced.has(ref.hash) || !available.has(ref.hash))
        .map((ref) => [ref.hash, ref]),
    );
    const additions = () => [...needed.values()].filter((ref) => !hashes.has(ref.hash));
    let added = additions();
    if (
      current.items.length &&
      (current.items.length === protocol.maxItems ||
        hashes.size + added.length > protocol.maxBlobs ||
        bytes + added.reduce((sum, ref) => sum + ref.bytes, 0) > budget)
    ) {
      batches.push(current);
      current = { items: [], blobs: [] };
      hashes = new Set();
      bytes = 0;
      added = additions();
    }
    if (
      added.length > protocol.maxBlobs ||
      bytes + added.reduce((sum, ref) => sum + ref.bytes, 0) > budget
    )
      throw new UserError(
        'A snapshot cannot fit the hosted batch upload limits. Local artifacts are retained.',
        1,
      );
    current.items.push(item);
    for (const ref of added) {
      hashes.add(ref.hash);
      bytes += ref.bytes;
      current.blobs.push(ref);
    }
  }
  if (current.items.length) batches.push(current);
  return batches;
}

export async function uploadVerifiedBatches(
  protocol: UploadProtocol,
  snapshots: BatchSnapshot[],
  load: (ref: ArtifactRef) => Promise<Buffer>,
  send: Send,
  onProgress?: (message: string) => void,
): Promise<number> {
  const all = new Map<string, ArtifactRef>();
  for (const item of snapshots)
    for (const ref of artifactRefs(item)) {
      if (
        !SHA.test(ref.hash) ||
        !Number.isInteger(ref.bytes) ||
        ref.bytes <= 0 ||
        ref.bytes > protocol.maxArtifactBytes ||
        (all.has(ref.hash) && all.get(ref.hash)!.bytes !== ref.bytes)
      )
        throw invalid();
      all.set(ref.hash, ref);
    }
  const refs = [...all.values()],
    available = new Set<string>();
  onProgress?.(`jux: checking ${refs.length} verified artifact hashes\n`);
  for (let offset = 0; offset < refs.length; offset += protocol.maxProbeItems) {
    const artifacts = refs.slice(offset, offset + protocol.maxProbeItems),
      requested = new Map(artifacts.map((ref) => [ref.hash, ref.bytes]));
    const body = JSON.stringify({ artifacts });
    if (Buffer.byteLength(body) > 32768) throw invalid();
    const response = await send(protocol.probePath, body);
    if (
      !object(response) ||
      !Array.isArray(response.available) ||
      !Array.isArray(response.missing)
    )
      throw invalid();
    const seen = new Set<string>();
    for (const [key, values] of [
      ['available', response.available],
      ['missing', response.missing],
    ] as const)
      for (const ref of values) {
        if (
          !object(ref) ||
          typeof ref.hash !== 'string' ||
          !requested.has(ref.hash) ||
          requested.get(ref.hash) !== ref.bytes ||
          seen.has(ref.hash)
        )
          throw invalid();
        seen.add(ref.hash);
        if (key === 'available') available.add(ref.hash);
      }
    if (seen.size !== requested.size) throw invalid();
  }
  const reusableBytes = refs
    .filter((ref) => available.has(ref.hash))
    .reduce((sum, ref) => sum + ref.bytes, 0);
  const missingBytes = refs.reduce((sum, ref) => sum + ref.bytes, 0) - reusableBytes;
  onProgress?.(
    `jux: verified cache ${available.size}/${refs.length} artifacts reusable; ${reusableBytes} bytes initially skipped, ${missingBytes} unique bytes initially needed\n`,
  );
  // Cache eviction can make every declared ref missing during a direct retry.
  const queue = partition(
    snapshots,
    protocol.direct ? new Set() : available,
    new Set(),
    protocol,
  );
  if (protocol.direct)
    return uploadDirectBatches(
      protocol.direct,
      queue.map((batch) => batch.items),
      load,
      send,
      onProgress,
    );
  let next = 0,
    completed = 0,
    deduped = 0,
    failed = false;
  let failure: unknown;
  const accepted = new Set<string>(),
    snapshotIds = new Set<string>();
  onProgress?.(
    `jux: uploading 0/${snapshots.length} snapshots (verified batches, up to 4 at once)\n`,
  );
  const upload = async (initial: BatchSnapshot[]) => {
    let pending = initial;
    const forced = new Set<string>();
    for (let attempt = 0; pending.length && attempt < 3; attempt++) {
      if (failed) return;
      const retry: BatchSnapshot[] = [];
      // Repartition retries: a cache eviction can turn a metadata-only batch
      // into multiple bounded requests when its artifacts need re-supplying.
      for (const batch of partition(pending, available, forced, protocol)) {
        if (failed) return;
        const manifest = JSON.stringify({ items: batch.items });
        if (Buffer.byteLength(manifest) > 65536) throw invalid();
        const form = new FormData();
        form.set('manifest', manifest);
        for (const ref of batch.blobs) {
          const bytes = await load(ref);
          if (
            bytes.length !== ref.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== ref.hash
          )
            throw new UserError(
              'Run artifacts changed during upload; retry after capture completes.',
              1,
            );
          form.set(
            `blob:${ref.hash}`,
            new Blob([new Uint8Array(bytes)], { type: 'image/webp' }),
            'artifact.webp',
          );
        }
        if (failed) return;
        const response = await send(protocol.batchPath, form);
        if (failed) return;
        if (
          !object(response) ||
          !Array.isArray(response.results) ||
          response.results.length !== batch.items.length
        )
          throw invalid();
        const expected = new Map(batch.items.map((item) => [item.storyIdSafe, item])),
          seen = new Set<string>();
        const receiptSnapshotIds = new Set<string>();
        const receipts: Array<{ item: BatchSnapshot; result: Record<string, unknown> }> =
          [];
        for (const result of response.results) {
          if (
            !object(result) ||
            typeof result.storyIdSafe !== 'string' ||
            seen.has(result.storyIdSafe) ||
            !expected.has(result.storyIdSafe) ||
            typeof result.status !== 'number' ||
            !Number.isInteger(result.status)
          )
            throw invalid();
          seen.add(result.storyIdSafe);
          receipts.push({ item: expected.get(result.storyIdSafe)!, result });
          if (result.status === 200 || result.status === 201) {
            if (
              typeof result.snapshotId !== 'string' ||
              !UUID.test(result.snapshotId) ||
              typeof result.deduped !== 'boolean' ||
              snapshotIds.has(result.snapshotId) ||
              receiptSnapshotIds.has(result.snapshotId)
            )
              throw invalid();
            receiptSnapshotIds.add(result.snapshotId);
          } else if (result.status < 400 || result.status > 599) throw invalid();
        }
        for (const { item, result } of receipts) {
          if (result.status === 200 || result.status === 201) {
            if (accepted.has(item.storyIdSafe)) throw invalid();
            accepted.add(item.storyIdSafe);
            snapshotIds.add(result.snapshotId as string);
            for (const ref of artifactRefs(item)) available.add(ref.hash);
            if (result.deduped === true) deduped++;
            completed++;
            onProgress?.(`jux: uploaded ${completed}/${snapshots.length} snapshots\n`);
            continue;
          }
          if (
            result.status === 409 &&
            result.error === 'missing_artifacts' &&
            result.retryable === true
          ) {
            const allowed = new Set(artifactRefs(item).map((ref) => ref.hash));
            if (
              !Array.isArray(result.missingHashes) ||
              !result.missingHashes.length ||
              result.missingHashes.some(
                (hash) => typeof hash !== 'string' || !allowed.has(hash),
              )
            )
              throw invalid();
            for (const hash of result.missingHashes as string[]) {
              forced.add(hash);
              available.delete(hash);
            }
          } else if (result.status === 409 && result.error === 'snapshot_conflict') {
            throw new UserError(
              'Hosted snapshot identity conflicts with an existing upload. Recapture into a new run; local artifacts are retained.',
              1,
            );
          } else if (
            result.retryable !== true ||
            ![500, 502, 503, 504].includes(result.status as number)
          ) {
            throw new UserError(
              `Hosted batch upload failed (HTTP ${String(result.status)}). Local artifacts are retained; retry with jux upload --run <directory>.`,
              1,
            );
          }
          retry.push(item);
        }
      }
      pending = retry;
      if (pending.length && attempt < 2 && !failed)
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (pending.length)
      throw new UserError(
        'Hosted batch upload retries exhausted. Local artifacts are retained; retry with jux upload --run <directory>.',
        1,
      );
  };
  const worker = async () => {
    while (!failed && next < queue.length) {
      const batch = queue[next++]!;
      try {
        await upload(batch.items);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  if (failed) throw failure;
  if (completed !== snapshots.length) throw invalid();
  return deduped;
}
