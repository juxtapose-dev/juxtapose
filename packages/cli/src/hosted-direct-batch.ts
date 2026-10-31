import { createHash } from 'node:crypto';
import type { ArtifactRef, BatchSnapshot } from './hosted-batch-upload.js';
import { DirectPutError, putDirect } from './direct-put.js';
import { UserError } from './user-error.js';

export interface DirectBatchProtocol {
  schema: 'juxtapose.snapshot-upload/v1';
  preparePath: string;
  finalizePath: string;
  maxConcurrentPuts: number;
}
type Send = (route: string, body: string | FormData) => Promise<Record<string, unknown>>;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid = () =>
  new UserError(
    'Hosted service returned invalid direct batch upload evidence. Local artifacts are retained.',
    1,
  );
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const refs = (item: BatchSnapshot) =>
  Object.values(item.artifacts).filter((ref): ref is ArtifactRef => ref !== undefined);
type Row = { item: BatchSnapshot; result: Record<string, unknown> };
function rows(value: unknown, items: BatchSnapshot[], preparing: boolean): Row[] {
  if (
    !object(value) ||
    !Array.isArray(value.results) ||
    value.results.length !== items.length
  )
    throw invalid();
  const expected = new Map(items.map((item) => [item.storyIdSafe, item])),
    seen = new Set<string>();
  return value.results.map((result) => {
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
    if (result.status === 200 || (!preparing && result.status === 201)) {
      if (
        typeof result.snapshotId !== 'string' ||
        !UUID.test(result.snapshotId) ||
        typeof result.deduped !== 'boolean'
      )
        throw invalid();
    } else if (
      !(preparing && result.status === 202) &&
      (result.status < 400 || result.status > 599)
    )
      throw invalid();
    return { item: expected.get(result.storyIdSafe)!, result };
  });
}

/** The semaphore is shared by every batch; acquire before loading a payload. */
export async function uploadDirectBatches(
  protocol: DirectBatchProtocol,
  batches: BatchSnapshot[][],
  load: (ref: ArtifactRef) => Promise<Buffer>,
  send: Send,
  onProgress?: (message: string) => void,
): Promise<number> {
  let active = 0,
    next = 0,
    failed = false,
    failure: unknown,
    deduped = 0;
  const waiters: (() => void)[] = [],
    accepted = new Set<string>(),
    snapshotIds = new Set<string>();
  const total = batches.reduce((n, batch) => n + batch.length, 0);
  const fail = (error: unknown) => {
    if (!failed) failure = error;
    failed = true;
  };
  const slot = async (work: () => Promise<void>) => {
    if (active >= protocol.maxConcurrentPuts)
      await new Promise<void>((resolve) => waiters.push(resolve));
    else active++;
    try {
      if (!failed) await work();
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      const waiter = waiters.shift();
      if (waiter) waiter();
      else active--;
    }
  };
  const consume = (values: Row[], forced: Set<string>): BatchSnapshot[] => {
    const retry: BatchSnapshot[] = [];
    for (const { item, result } of values) {
      if (result.status === 200 || result.status === 201) {
        const snapshotId = result.snapshotId as string;
        if (accepted.has(item.storyIdSafe) || snapshotIds.has(snapshotId))
          throw invalid();
        accepted.add(item.storyIdSafe);
        snapshotIds.add(snapshotId);
        if (result.deduped) deduped++;
        onProgress?.(`jux: uploaded ${accepted.size}/${total} snapshots\n`);
      } else if (
        result.status === 409 &&
        result.error === 'missing_artifacts' &&
        result.retryable === true
      ) {
        const allowed = new Set(refs(item).map((ref) => ref.hash));
        if (
          !Array.isArray(result.missingHashes) ||
          !result.missingHashes.length ||
          new Set(result.missingHashes).size !== result.missingHashes.length ||
          result.missingHashes.some(
            (hash) => typeof hash !== 'string' || !allowed.has(hash),
          )
        )
          throw invalid();
        for (const hash of result.missingHashes as string[]) forced.add(hash);
        retry.push(item);
      } else if (
        result.retryable === true &&
        [500, 502, 503, 504].includes(result.status as number)
      )
        retry.push(item);
      else
        throw new UserError(
          `Hosted direct batch upload failed (HTTP ${String(result.status)}). Local artifacts are retained; retry with jux upload --run <directory>.`,
          1,
        );
    }
    return retry;
  };
  const upload = async (initial: BatchSnapshot[]) => {
    let pending = initial;
    const forced = new Set<string>();
    for (let attempt = 0; pending.length && attempt < 3 && !failed; attempt++) {
      const allowed = new Map(
        pending.flatMap((item) => refs(item).map((ref) => [ref.hash, ref] as const)),
      );
      const request = JSON.stringify({
        items: pending,
        ...(forced.size
          ? { forceHashes: [...forced].filter((hash) => allowed.has(hash)) }
          : {}),
      });
      if (Buffer.byteLength(request) > 65536) throw invalid();
      const preparation = await send(protocol.preparePath, request);
      if (failed) return;
      if (
        preparation.schema !== 'juxtapose.snapshot-upload-preparation/v1' ||
        !Array.isArray(preparation.artifacts)
      )
        throw invalid();
      const results = rows(preparation, pending, true);
      const sessions: { storyIdSafe: string; attemptId: string }[] = [],
        prepared: BatchSnapshot[] = [];
      const needed = new Set<string>();
      for (const { item, result } of results)
        if (result.status === 202) {
          const session = result.directUpload,
            own = new Set(refs(item).map((ref) => ref.hash));
          if (
            !object(session) ||
            Object.keys(session).length !== 2 ||
            typeof session.attemptId !== 'string' ||
            !UUID.test(session.attemptId) ||
            !Array.isArray(session.requiredHashes) ||
            new Set(session.requiredHashes).size !== session.requiredHashes.length ||
            session.requiredHashes.some(
              (hash) => typeof hash !== 'string' || !own.has(hash),
            )
          )
            throw invalid();
          for (const hash of session.requiredHashes as string[]) needed.add(hash);
          sessions.push({ storyIdSafe: item.storyIdSafe, attemptId: session.attemptId });
          prepared.push(item);
        }
      const artifacts: { ref: ArtifactRef; descriptor: unknown }[] = [],
        seen = new Set<string>();
      for (const artifact of preparation.artifacts) {
        if (
          !object(artifact) ||
          Object.keys(artifact).length !== 3 ||
          typeof artifact.hash !== 'string' ||
          seen.has(artifact.hash) ||
          !needed.has(artifact.hash) ||
          artifact.bytes !== allowed.get(artifact.hash)?.bytes ||
          !Object.hasOwn(artifact, 'descriptor')
        )
          throw invalid();
        seen.add(artifact.hash);
        artifacts.push({
          ref: allowed.get(artifact.hash)!,
          descriptor: artifact.descriptor,
        });
      }
      if (seen.size !== needed.size) throw invalid();
      const retry = consume(
        results.filter((row) => row.result.status !== 202),
        forced,
      );
      const transfers = await Promise.allSettled(
        artifacts.map((artifact) =>
          slot(async () => {
            const bytes = await load(artifact.ref);
            if (failed) return;
            if (
              bytes.length !== artifact.ref.bytes ||
              createHash('sha256').update(bytes).digest('hex') !== artifact.ref.hash
            )
              throw new UserError(
                'Run artifacts changed during upload; retry after capture completes.',
                1,
              );
            try {
              await putDirect(artifact.descriptor, bytes, 'image/webp');
            } catch (error) {
              if (!(error instanceof DirectPutError) || error.reason === 'invalid')
                throw error;
            }
          }),
        ),
      );
      const rejected = transfers.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      if (failed) return;
      if (sessions.length) {
        const final = await send(
          protocol.finalizePath,
          JSON.stringify({ items: sessions }),
        );
        retry.push(...consume(rows(final, prepared, false), forced));
      }
      pending = retry;
      if (pending.length && attempt < 2 && !failed)
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (pending.length && !failed)
      throw new UserError(
        'Hosted direct batch retries exhausted. Local artifacts are retained; retry with jux upload --run <directory>.',
        1,
      );
  };
  const worker = async () => {
    while (!failed && next < batches.length) {
      try {
        await upload(batches[next++]!);
      } catch (error) {
        fail(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
  if (failed) throw failure;
  if (accepted.size !== total) throw invalid();
  return deduped;
}
