import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { waitForManagedBuild, resumeManagedBuild } from './managed-wait.js';
import type { BuildReceipt } from './managed-submit.js';
const buildId = '10000000-0000-4000-8000-000000000001',
  sourceSha = 'a'.repeat(40);
const receipt: BuildReceipt = {
  build: {
    id: buildId,
    status: 'uploaded',
    sourceSha,
    branch: 'feature',
    archiveSha256: 'b'.repeat(64),
    archiveBytes: 100,
    captureStatus: 'not_started',
    sourceVerified: false,
  },
  upload: {
    method: 'PUT',
    path: `/v1/builds/${buildId}/archive`,
    contentType: 'application/gzip',
  },
};
const status = (terminal = false) => ({
  schema: 'juxtapose.managed-status/v1',
  buildId,
  sourceSha,
  phase: terminal ? 'review' : 'capture',
  terminal,
  reason: null,
  recovery: terminal ? 'none' : 'automatic',
  retryAfterMs: 250,
  validation: { status: 'ready' },
  execution: { status: terminal ? 'completed' : 'running' },
  comparison: { status: terminal ? 'completed' : 'not_started' },
  publication: { status: terminal ? 'completed' : 'not_started' },
  review: {
    state: terminal ? 'ready' : 'waiting_capture',
    runId: terminal ? buildId : null,
    url: terminal ? `https://app.juxtapose.dev/acme/app/runs/${buildId}` : null,
    verdict: terminal ? 'needs_review' : 'incomplete',
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('triggers idempotent capture then polls a real HTTP service to publication rather than validation ready', async () => {
  const requests: string[] = [];
  let reads = 0;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    expect(req.headers.authorization).toBe('Bearer test-token');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          capture: { buildId, status: 'ready', jobId: buildId, error: null },
        }),
      );
    } else {
      reads++;
      res.end(JSON.stringify(status(reads > 1)));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    await expect(
      waitForManagedBuild(
        receipt,
        { origin: `http://127.0.0.1:${address.port}`, token: 'test-token' },
        { timeoutMs: 5000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ terminal: true, review: { verdict: 'needs_review' } });
    expect(requests).toEqual([
      `POST /v1/builds/${buildId}/capture`,
      `GET /v1/builds/${buildId}/status`,
      `GET /v1/builds/${buildId}/status`,
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('rejects wrong source/build and redirects without sending bearer credentials elsewhere', async () => {
  let calls = 0;
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify(
          ++calls === 1
            ? { capture: { buildId, status: 'ready' } }
            : { ...status(true), sourceSha: 'c'.repeat(40) },
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    waitForManagedBuild(
      receipt,
      { origin: 'https://api.test', token: 'secret' },
      { timeoutMs: 1000, pollMs: 1 },
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalled();
});
it('bounds a stalled body and cancels its reader on timeout and caller abort', async () => {
  for (const interrupt of ['timeout', 'abort']) {
    const cancel = vi.fn();
    let count = 0;
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        count++;
        return count === 1
          ? Response.json({ capture: { buildId, status: 'ready' } })
          : new Response(new ReadableStream({ cancel }), {
              headers: { 'content-type': 'application/json' },
            });
      }),
    );
    const pending = waitForManagedBuild(
      receipt,
      { origin: 'https://api.test', token: 'secret' },
      {
        timeoutMs: interrupt === 'timeout' ? 30 : 1000,
        pollMs: 1,
        signal: controller.signal,
      },
    ).catch((e) => e);
    if (interrupt === 'abort') setTimeout(() => controller.abort(), 20);
    expect(await pending).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledOnce();
  }
});
it('rejects redirects, oversize responses and contradictory terminal green receipts', async () => {
  const config = { origin: 'https://api.test', token: 'secret' };
  const redirect = vi.fn(
    async () =>
      new Response(null, { status: 307, headers: { location: 'https://other.test' } }),
  );
  vi.stubGlobal('fetch', redirect);
  await expect(
    waitForManagedBuild(receipt, config, { timeoutMs: 1000, pollMs: 1 }),
  ).rejects.toThrow(/HTTP 307/);
  expect(redirect).toHaveBeenCalledOnce();
  expect(redirect.mock.calls[0]).toBeDefined();
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ++reads === 1
        ? Response.json({ capture: { buildId, status: 'ready' } })
        : new Response('x'.repeat(65537), {
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
  await expect(
    waitForManagedBuild(receipt, config, { timeoutMs: 1000, pollMs: 1 }),
  ).rejects.toThrow(/response limit/);
  reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        ++reads === 1
          ? { capture: { buildId, status: 'ready' } }
          : { ...status(true), execution: { status: 'queued' } },
      ),
    ),
  );
  await expect(
    waitForManagedBuild(receipt, config, { timeoutMs: 1000, pollMs: 1 }),
  ).rejects.toThrow(/invalid managed status/);
});
it('cancels a response arriving after the caller has stopped waiting', async () => {
  const controller = new AbortController(),
    cancel = vi.fn();
  let finish: (response: Response) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = waitForManagedBuild(
    receipt,
    { origin: 'https://api.test', token: 'secret' },
    { timeoutMs: 1000, pollMs: 1, signal: controller.signal },
  ).catch((error) => error);
  controller.abort();
  expect(await pending).toBeInstanceOf(Error);
  finish(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(cancel).toHaveBeenCalledOnce();
});

it('reads existing paused ready/queued builds without build creation, upload or capture writes', async () => {
  for (const payload of [
    status(true),
    {
      ...status(false),
      terminal: true,
      reason: 'execution_disabled',
      recovery: 'operator',
      execution: { status: 'queued' },
    },
  ]) {
    const fetcher = vi.fn(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      resumeManagedBuild(
        buildId,
        { origin: 'https://api.test', token: 'secret' },
        { timeoutMs: 1000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ buildId, terminal: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toBeDefined();
  }
});
it('falls back to exact scoped status only when capture becomes disabled after upload', async () => {
  let calls = 0;
  const fetcher = vi.fn(async () =>
    ++calls === 1
      ? Response.json({ error: 'not_found' }, { status: 404 })
      : Response.json(status(true)),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    waitForManagedBuild(
      receipt,
      { origin: 'https://api.test', token: 'secret' },
      { timeoutMs: 1000, pollMs: 1 },
    ),
  ).resolves.toMatchObject({ review: { verdict: 'needs_review' } });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('latches the resumed server source and rejects a source changing across polls', async () => {
  let calls = 0;
  const fetcher = vi.fn(async () =>
    Response.json(
      ++calls === 1 ? status(false) : { ...status(true), sourceSha: 'c'.repeat(40) },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    resumeManagedBuild(
      buildId,
      { origin: 'https://api.test', token: 'secret' },
      { timeoutMs: 1000, pollMs: 1 },
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('retains non-disabled trigger conflicts instead of falling back to an old review', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'profile_conflict' }, { status: 409 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    waitForManagedBuild(
      receipt,
      { origin: 'https://api.test', token: 'secret' },
      { timeoutMs: 1000, pollMs: 1 },
    ),
  ).rejects.toThrow(/HTTP 409/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('requires exact durable GitHub delivery for handoff and waits within the same deadline', async () => {
  const config = { origin: 'https://api.test', token: 'secret' };
  const delivery = {
    state: 'delivered',
    runId: buildId,
    headSha: sourceSha,
    checkRunId: 123,
    summarySha256: 'b'.repeat(64),
  };
  for (const invalid of [
    undefined,
    { ...delivery, runId: '20000000-0000-4000-8000-000000000001' },
    { ...delivery, headSha: 'c'.repeat(40) },
    { ...delivery, checkRunId: null },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...status(true), githubReview: invalid })),
    );
    await expect(
      resumeManagedBuild(buildId, config, {
        timeoutMs: 1000,
        pollMs: 1,
        requireGithubDelivery: true,
      }),
    ).rejects.toThrow();
  }
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...status(true),
        githubReview:
          ++reads === 1
            ? { ...delivery, state: 'pending', checkRunId: null, summarySha256: null }
            : delivery,
      }),
    ),
  );
  await expect(
    resumeManagedBuild(buildId, config, {
      timeoutMs: 1000,
      pollMs: 1,
      requireGithubDelivery: true,
    }),
  ).resolves.toMatchObject({ githubReview: delivery });
  expect(reads).toBe(2);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...status(true),
        githubReview: {
          ...delivery,
          state: 'pending',
          checkRunId: null,
          summarySha256: null,
        },
      }),
    ),
  );
  await expect(
    resumeManagedBuild(buildId, config, {
      timeoutMs: 20,
      pollMs: 1,
      requireGithubDelivery: true,
    }),
  ).rejects.toThrow(/timed out/);
});
