import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  readUploadProtocol,
  uploadVerifiedBatches,
  type BatchSnapshot,
} from './hosted-batch-upload.js';
const run = '019a0000-0000-7000-8000-000000000001';
const attemptId = '019a0000-0000-7000-8000-000000000002';
const protocol = () =>
  readUploadProtocol(
    {
      version: 1,
      probePath: `/v1/runs/${run}/artifacts/probe`,
      batchPath: `/v1/runs/${run}/snapshots/batch`,
      maxItems: 16,
      maxBlobs: 32,
      maxRequestBytes: 8388608,
      maxArtifactBytes: 1048576,
      maxProbeItems: 256,
      direct: {
        schema: 'juxtapose.snapshot-upload/v1',
        preparePath: `/v1/runs/${run}/snapshots/direct/prepare`,
        finalizePath: `/v1/runs/${run}/snapshots/direct/finalize`,
        maxConcurrentPuts: 4,
      },
    },
    run,
  )!;
const body = Buffer.alloc(100, 1);
const hash = createHash('sha256').update(body).digest('hex');
const item = (i: number): BatchSnapshot => ({
  storyIdSafe: String(i).padStart(24, '0'),
  meta: {
    storyId: `story-${i}`,
    status: 'new',
    mismatchPixels: 0,
    mismatchPercent: 0,
    durationMs: 1,
    contentHash: hash,
  },
  artifacts: { current: { hash, bytes: 100 }, thumb: { hash, bytes: 100 } },
});
function descriptor(key: string) {
  const issuedAtMs = Math.floor(Date.now() / 1000) * 1000;
  const date = new Date(issuedAtMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const url = new URL(
    `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/private/${key}`,
  );
  for (const [k, v] of Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `TESTACCESSKEY123456/${date.slice(0, 8)}/auto/s3/aws4_request`,
    'X-Amz-Date': date,
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'content-length;content-type;host;if-none-match',
    'X-Amz-Signature': 'f'.repeat(64),
  }))
    url.searchParams.set(k, v);
  return {
    schema: 'juxtapose.direct-put/v1',
    method: 'PUT',
    url: url.href,
    headers: {
      'content-type': 'image/webp',
      'content-length': '100',
      'if-none-match': '*',
    },
    bytes: 100,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 300000,
  };
}
function preparation(items: BatchSnapshot[], key = 'attempt') {
  return {
    schema: 'juxtapose.snapshot-upload-preparation/v1',
    results: items.map((x) => ({
      storyIdSafe: x.storyIdSafe,
      status: 202,
      directUpload: { attemptId, requiredHashes: [hash] },
    })),
    artifacts: [{ hash, bytes: 100, descriptor: descriptor(key) }],
  };
}
const accepted = (items: { storyIdSafe: string }[]) => ({
  results: items.map((x) => ({
    storyIdSafe: x.storyIdSafe,
    status: 201,
    snapshotId: `019a0000-0000-7000-8000-${x.storyIdSafe.slice(-12)}`,
    deduped: false,
  })),
});
afterEach(() => vi.unstubAllGlobals());
it('coalesces identical in-flight capabilities across batches without retaining their payloads', async () => {
  const snapshots = [item(1), item(2)],
    config = protocol();
  config.maxItems = 1;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async () => {
    await hold;
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const shared = descriptor('same-private-generation');
  const load = vi.fn(async () => body);
  const send = async (route: string, raw: string | FormData) => {
    const data = JSON.parse(raw as string);
    if (route.endsWith('/probe'))
      return { available: [], missing: [{ hash, bytes: 100 }] };
    if (route.endsWith('/prepare'))
      return {
        ...preparation(data.items),
        artifacts: [{ hash, bytes: 100, descriptor: shared }],
      };
    return accepted(data.items);
  };
  const pending = uploadVerifiedBatches(config, snapshots, load, send);
  await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  expect(await pending).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
});
it('bounds declared hashes even when every artifact is initially cached', async () => {
  const snapshots = Array.from({ length: 10 }, (_, i) => {
    const snapshot = item(i + 1);
    snapshot.artifacts = Object.fromEntries(
      ['current', 'thumb', 'diff', 'baseline', 'review'].map((role, j) => [
        role,
        { hash: createHash('sha256').update(`${i}-${j}`).digest('hex'), bytes: 100 },
      ]),
    );
    snapshot.meta.contentHash = snapshot.artifacts.current!.hash;
    return snapshot;
  });
  let prepares = 0;
  const send = async (route: string, raw: string | FormData) => {
    const data = JSON.parse(raw as string);
    if (route.endsWith('/probe')) return { available: data.artifacts, missing: [] };
    if (route.endsWith('/prepare')) {
      prepares++;
      const items = data.items as BatchSnapshot[];
      expect(
        new Set(items.flatMap((x) => Object.values(x.artifacts).map((ref) => ref!.hash)))
          .size,
      ).toBeLessThanOrEqual(32);
      return {
        schema: 'juxtapose.snapshot-upload-preparation/v1',
        artifacts: [],
        results: items.map((x) => ({
          storyIdSafe: x.storyIdSafe,
          status: 202,
          directUpload: { attemptId, requiredHashes: [] },
        })),
      };
    }
    return accepted(data.items);
  };
  const load = vi.fn(async () => body);
  expect(await uploadVerifiedBatches(protocol(), snapshots, load, send)).toBe(0);
  expect(prepares).toBe(2);
  expect(load).not.toHaveBeenCalled();
});
it('repeats a settled capability after a missing-artifact finalize instead of caching PUT success', async () => {
  const snapshots = [item(1)],
    shared = descriptor('retry-same-private-generation'),
    load = vi.fn(async () => body),
    fetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  let prepares = 0,
    finals = 0;
  const send = async (route: string, raw: string | FormData) => {
    const data = JSON.parse(raw as string);
    if (route.endsWith('/probe'))
      return { available: [], missing: [{ hash, bytes: 100 }] };
    if (route.endsWith('/prepare')) {
      expect(data.forceHashes).toEqual(++prepares === 1 ? undefined : [hash]);
      return {
        ...preparation(snapshots),
        artifacts: [{ hash, bytes: 100, descriptor: shared }],
      };
    }
    expect(data.items).toEqual([{ storyIdSafe: snapshots[0]!.storyIdSafe, attemptId }]);
    if (++finals === 1)
      return {
        results: [
          {
            storyIdSafe: snapshots[0]!.storyIdSafe,
            status: 409,
            error: 'missing_artifacts',
            retryable: true,
            missingHashes: [hash],
          },
        ],
      };
    return accepted(snapshots);
  };
  expect(await uploadVerifiedBatches(protocol(), snapshots, load, send)).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(2);
  expect(finals).toBe(2);
});
it('shares one external PUT across stories and roles before authenticated batch acceptance', async () => {
  const snapshots = [item(1), item(2)],
    load = vi.fn(async () => body);
  const fetch = vi.fn(async () => new Response(null, { status: 412 }));
  vi.stubGlobal('fetch', fetch);
  const send = vi.fn(async (route: string, raw: string | FormData) => {
    if (route.endsWith('/probe'))
      return { available: [], missing: [{ hash, bytes: 100 }] };
    expect(typeof raw).toBe('string');
    if (route.endsWith('/prepare')) return preparation(snapshots);
    expect(route).toContain('/direct/finalize');
    expect(JSON.parse(raw as string)).toEqual({
      items: snapshots.map((x) => ({ storyIdSafe: x.storyIdSafe, attemptId })),
    });
    return accepted(snapshots);
  });
  expect(await uploadVerifiedBatches(protocol(), snapshots, load, send)).toBe(0);
  expect(load).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(send.mock.calls)).not.toContain('X-Amz-');
});
it('rejects extra artifact descriptors before loading or uploading bytes', async () => {
  const snapshots = [item(1)],
    load = vi.fn(async () => body),
    fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const send = async (route: string) =>
    route.endsWith('/probe')
      ? { available: [], missing: [{ hash, bytes: 100 }] }
      : {
          ...preparation(snapshots),
          artifacts: [
            { hash: 'f'.repeat(64), bytes: 100, descriptor: descriptor('bad') },
          ],
        };
  await expect(uploadVerifiedBatches(protocol(), snapshots, load, send)).rejects.toThrow(
    /invalid/i,
  );
  expect(load).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('bounds all direct PUTs and byte loads globally while multiple batches run', async () => {
  const snapshots = Array.from({ length: 8 }, (_, i) => item(i + 1));
  const config = protocol();
  config.maxItems = 1;
  let active = 0,
    peak = 0,
    loads = 0,
    completed = 0;
  const releases: (() => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      completed++;
      return new Response(null, { status: 200 });
    }),
  );
  const send = async (route: string, raw: string | FormData) => {
    if (route.endsWith('/probe'))
      return { available: [], missing: [{ hash, bytes: 100 }] };
    expect(typeof raw).toBe('string');
    const data = JSON.parse(raw as string) as { items: BatchSnapshot[] };
    return route.endsWith('/prepare')
      ? preparation(data.items, data.items[0]!.storyIdSafe)
      : accepted(data.items);
  };
  let done = false;
  const pending = uploadVerifiedBatches(
    config,
    snapshots,
    async () => {
      loads++;
      return body;
    },
    send,
  ).then(
    (value) => {
      done = true;
      return { value, error: undefined };
    },
    (error: unknown) => {
      done = true;
      return { value: undefined, error };
    },
  );
  while (!done) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(active).toBeLessThanOrEqual(4);
    expect(loads).toBeLessThanOrEqual(completed + 4);
    releases.splice(0).forEach((release) => release());
  }
  const outcome = await pending;
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toBe(0);
  expect(peak).toBe(4);
});
it('recovers a missing cache artifact with the same attempt and only requested hashes', async () => {
  const snapshots = [item(1)];
  let prepares = 0,
    finals = 0;
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const load = vi.fn(async () => body);
  const send = vi.fn(async (route: string, raw: string | FormData) => {
    if (route.endsWith('/probe'))
      return { available: [{ hash, bytes: 100 }], missing: [] };
    if (route.endsWith('/prepare')) {
      if (++prepares === 1)
        return {
          ...preparation(snapshots),
          artifacts: [],
          results: [
            {
              storyIdSafe: snapshots[0]!.storyIdSafe,
              status: 202,
              directUpload: { attemptId, requiredHashes: [] },
            },
          ],
        };
      expect(JSON.parse(raw as string).forceHashes).toEqual([hash]);
      return preparation(snapshots);
    }
    expect(JSON.parse(raw as string)).toEqual({
      items: [{ storyIdSafe: snapshots[0]!.storyIdSafe, attemptId }],
    });
    if (++finals === 1)
      return {
        results: [
          {
            storyIdSafe: snapshots[0]!.storyIdSafe,
            status: 409,
            error: 'missing_artifacts',
            retryable: true,
            missingHashes: [hash],
          },
        ],
      };
    return accepted(snapshots);
  });
  expect(await uploadVerifiedBatches(protocol(), snapshots, load, send)).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
});
it('finalizes ambiguous external failures but never accepts incomplete final rows', async () => {
  const snapshots = [item(1)];
  const fetch = vi.fn(async () => new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  const send = vi.fn(async (route: string) => {
    if (route.endsWith('/probe'))
      return { available: [], missing: [{ hash, bytes: 100 }] };
    if (route.endsWith('/prepare')) return preparation(snapshots);
    return { results: [{ storyIdSafe: snapshots[0]!.storyIdSafe, status: 202 }] };
  });
  await expect(
    uploadVerifiedBatches(protocol(), snapshots, async () => body, send),
  ).rejects.toThrow(/invalid/i);
  expect(send.mock.calls.at(-1)![0]).toContain('/finalize');
});
it('rejects changed local bytes before an external PUT or finalize', async () => {
  const snapshots = [item(1)],
    fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const send = vi.fn(async (route: string) =>
    route.endsWith('/probe')
      ? { available: [], missing: [{ hash, bytes: 100 }] }
      : preparation(snapshots),
  );
  await expect(
    uploadVerifiedBatches(protocol(), snapshots, async () => Buffer.alloc(100, 2), send),
  ).rejects.toThrow(/changed/i);
  expect(fetch).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(2);
});
it('rejects malformed direct advertisement instead of selecting old batch transport', () => {
  const config = protocol();
  config.direct!.preparePath = 'https://evil.invalid/';
  expect(() => readUploadProtocol(config, run)).toThrow(/invalid/i);
});
it('drains an in-flight PUT before rejecting a changed sibling file', async () => {
  const secondBody = Buffer.alloc(100, 2),
    secondHash = createHash('sha256').update(secondBody).digest('hex');
  const second = item(2);
  second.meta.contentHash = secondHash;
  second.artifacts = { current: { hash: secondHash, bytes: 100 } };
  const snapshots = [item(1), second];
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(null, { status: 200 });
    }),
  );
  const send = vi.fn(async (route: string) =>
    route.endsWith('/probe')
      ? {
          available: [],
          missing: [
            { hash, bytes: 100 },
            { hash: secondHash, bytes: 100 },
          ],
        }
      : {
          schema: 'juxtapose.snapshot-upload-preparation/v1',
          results: snapshots.map((x) => ({
            storyIdSafe: x.storyIdSafe,
            status: 202,
            directUpload: { attemptId, requiredHashes: [x.meta.contentHash] },
          })),
          artifacts: [
            { hash, bytes: 100, descriptor: descriptor('ok') },
            { hash: secondHash, bytes: 100, descriptor: descriptor('second') },
          ],
        },
  );
  let settled = false;
  const pending = uploadVerifiedBatches(
    protocol(),
    snapshots,
    async () => body,
    send,
  ).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(settled).toBe(false);
  release();
  expect(await pending).toBeInstanceOf(Error);
  expect(send).toHaveBeenCalledTimes(2);
});
it('accepts existing snapshot receipts without loading or uploading bytes', async () => {
  const snapshots = [item(1)],
    load = vi.fn(async () => body),
    fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const terminal = accepted(snapshots);
  terminal.results[0]!.status = 200;
  terminal.results[0]!.deduped = true;
  const send = async (route: string) =>
    route.endsWith('/probe')
      ? { available: [{ hash, bytes: 100 }], missing: [] }
      : {
          schema: 'juxtapose.snapshot-upload-preparation/v1',
          ...terminal,
          artifacts: [],
        };
  expect(await uploadVerifiedBatches(protocol(), snapshots, load, send)).toBe(1);
  expect(load).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  'duplicate-row',
  'duplicate-artifact',
  'missing-artifact',
  'foreign-hash',
] as const)('rejects %s preparation before transfer', async (kind) => {
  const snapshots = [item(1), item(2)],
    value = preparation(snapshots);
  if (kind === 'duplicate-row') value.results[1] = value.results[0]!;
  if (kind === 'duplicate-artifact') value.artifacts.push(value.artifacts[0]!);
  if (kind === 'missing-artifact') value.artifacts = [];
  if (kind === 'foreign-hash')
    value.results[0]!.directUpload.requiredHashes = ['f'.repeat(64)];
  const load = vi.fn(async () => body),
    fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const send = async (route: string) =>
    route.endsWith('/probe') ? { available: [], missing: [{ hash, bytes: 100 }] } : value;
  await expect(uploadVerifiedBatches(protocol(), snapshots, load, send)).rejects.toThrow(
    /invalid/i,
  );
  expect(load).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
