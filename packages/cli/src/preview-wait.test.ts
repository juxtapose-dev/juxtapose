import { afterEach, expect, it, vi } from 'vitest';
import { waitForPreview, type PreviewStatus } from './preview-wait.js';
const id = '10000000-0000-4000-8000-000000000001';
const config = { origin: 'https://api.juxtapose.dev', token: 'private-test-token' };
const options = { timeoutMs: 30_000, pollMs: 1 };
const status = (state: PreviewStatus['state'] = 'ready'): PreviewStatus => ({
  schema: 'juxtapose.preview-status/v1',
  buildId: id,
  sourceSha: 'a'.repeat(40),
  branch: 'feature/test',
  state,
  terminal: !['queued', 'validating', 'publishing'].includes(state),
  reason:
    (
      {
        disabled: 'preview_disabled',
        not_requested: 'preview_not_requested',
        failed: 'preview_failed',
        expired: 'preview_expired',
      } as const
    )[state as 'disabled' | 'not_requested' | 'failed' | 'expired'] ?? null,
  retryAfterMs: 2000,
  url:
    state === 'ready' ? `https://app.juxtapose.dev/acme/app/preview/build/${id}` : null,
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('polls publication with fixed authenticated GETs and never fetches the launch URL', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(status('queued')))
    .mockResolvedValueOnce(json(status('validating')))
    .mockResolvedValueOnce(json(status('publishing')))
    .mockResolvedValue(json(status()));
  vi.stubGlobal('fetch', fetcher);
  const progress: string[] = [];
  const pending = waitForPreview(id, config, {
    ...options,
    onProgress: (s) => progress.push(s.state),
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(await pending).toEqual(status());
  expect(progress).toEqual(['queued', 'validating', 'publishing', 'ready']);
  expect(fetcher).toHaveBeenCalledTimes(4);
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url)).toBe(`${config.origin}/v1/builds/${id}/preview`);
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { authorization: 'Bearer private-test-token' },
    });
  }
});
it.each([
  { buildId: '10000000-0000-4000-8000-000000000002' },
  { sourceSha: 'BAD' },
  { branch: 'bad\nbranch' },
  { schema: 'other' },
  { extra: 'private' },
  { terminal: false },
  { url: null },
  { state: 'completed' },
  { retryAfterMs: 1 },
  { reason: 'raw provider URL' },
  { url: 'https://evil.invalid/acme/app/preview/build/' + id },
  { url: `https://app.juxtapose.dev/acme/app/preview/build/${id}?token=secret` },
  { url: `https://app.juxtapose.dev/acme/app/preview/build/${id}#fragment` },
  { url: `https://x@app.juxtapose.dev/acme/app/preview/build/${id}` },
  {
    url: `https://app.juxtapose.dev/acme/app/preview/build/10000000-0000-4000-8000-000000000002`,
  },
  { state: 'publishing', terminal: false },
])(
  'rejects malformed or unsafe status without accepting or retrying it: %j',
  async (patch) => {
    const fetcher = vi.fn().mockResolvedValue(json({ ...status(), ...patch }));
    vi.stubGlobal('fetch', fetcher);
    await expect(waitForPreview(id, config, options)).rejects.toMatchObject({
      code: 'preview_protocol',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('pins resumed source and branch across polls, including a source shared by different branches', async () => {
  vi.useFakeTimers();
  for (const patch of [{ sourceSha: 'b'.repeat(40) }, { branch: 'other' }]) {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(status('publishing')))
      .mockResolvedValue(json({ ...status(), ...patch }));
    vi.stubGlobal('fetch', fetcher);
    const pending = waitForPreview(id, config, options);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'preview_protocol' });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  }
});
it('accepts only the staging API-to-app mapping, refusing launch URLs for custom origins', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async () =>
        json({ ...status(), url: status().url!.replace('app.', 'app-staging.') }),
      ),
  );
  await expect(
    waitForPreview(
      id,
      { ...config, origin: 'https://api-staging.juxtapose.dev' },
      options,
    ),
  ).resolves.toMatchObject({ state: 'ready' });
  await expect(
    waitForPreview(id, { ...config, origin: 'https://custom.invalid' }, options),
  ).rejects.toMatchObject({ code: 'preview_protocol' });
});
it.each(['disabled', 'not_requested', 'failed', 'expired'] as const)(
  'returns terminal %s without retry, capture or URL',
  async (state) => {
    const fetcher = vi.fn().mockResolvedValue(json(status(state)));
    vi.stubGlobal('fetch', fetcher);
    await expect(waitForPreview(id, config, options)).resolves.toMatchObject({
      state,
      terminal: true,
      url: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('returns a viewer-disabled READY as a terminal configuration block for the command', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(json({ ...status(), reason: 'viewer_disabled', url: null }));
  vi.stubGlobal('fetch', fetcher);
  await expect(waitForPreview(id, config, options)).resolves.toMatchObject({
    terminal: true,
    reason: 'viewer_disabled',
    url: null,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([301, 401, 403, 404, 500])(
  'does not retry HTTP %s, drains its body and never follows redirects',
  async (httpStatus) => {
    const cancel = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: httpStatus,
        headers: { location: 'https://evil.invalid/token' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(waitForPreview(id, config, options)).rejects.toMatchObject({
      code: httpStatus === 404 ? 'preview_unsupported' : 'preview_unavailable',
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);
it.each([429, 502, 503, 504, 'transport', 'body_loss'])(
  'retries transient %s under the same identity and budget',
  async (failure) => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    if (failure === 'transport')
      fetcher.mockRejectedValueOnce(new Error('private raw transport'));
    else if (failure === 'body_loss')
      fetcher.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error('private body loss'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    else
      fetcher.mockResolvedValueOnce(
        new Response('private provider body', { status: failure }),
      );
    fetcher.mockResolvedValue(json(status()));
    vi.stubGlobal('fetch', fetcher);
    const pending = waitForPreview(id, config, options);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual(status());
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it.each(['malformed', 'oversize', 'invalid_utf8'])(
  'rejects complete %s bytes once, without leaking or trusting content-length',
  async (kind) => {
    const cancel = vi.fn();
    const bytes =
      kind === 'oversize'
        ? new Uint8Array(65537)
        : kind === 'invalid_utf8'
          ? new Uint8Array([255])
          : new TextEncoder().encode('{"private":"secret"');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        if (kind !== 'oversize') c.close();
      },
      cancel,
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'content-type': 'application/json', 'content-length': '1' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(waitForPreview(id, config, options)).rejects.toMatchObject({
      code: 'preview_protocol',
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (kind === 'oversize') expect(cancel).toHaveBeenCalledTimes(1);
  },
);
it('keeps one absolute monotonic deadline despite progress and wall-clock changes', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(async () => json(status('publishing')));
  vi.stubGlobal('fetch', fetcher);
  const pending = waitForPreview(id, config, {
    timeoutMs: 5000,
    pollMs: 1,
    onProgress: () => vi.setSystemTime(new Date(0)),
  });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'wait_timeout' });
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it('aborts a stalled body and clears its wait timer', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  const pending = waitForPreview(id, config, { ...options, signal: controller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'interrupted' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assertion;
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('disposes a response arriving after interrupted fetch even if the transport ignores abort', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  let arrive!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          arrive = resolve;
        }),
    ),
  );
  const pending = waitForPreview(id, config, { ...options, signal: controller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'interrupted' });
  controller.abort();
  await assertion;
  arrive(new Response(new ReadableStream({ cancel })));
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([
  { state: 'queued', terminal: false, reason: 'preview_disabled' },
  { state: 'validating', terminal: false, reason: 'preview_failed' },
  { state: 'publishing', terminal: false, reason: 'source_changed' },
  { state: 'ready', reason: 'source_changed' },
  { state: 'failed', reason: 'preview_expired' },
  { state: 'expired', reason: 'preview_failed' },
  { state: 'disabled', reason: null },
  { state: 'not_requested', reason: 'viewer_disabled' },
])('rejects invalid state/reason pairs %j', async (patch) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(json({ ...status(), url: null, ...patch })),
  );
  await expect(waitForPreview(id, config, options)).rejects.toMatchObject({
    code: 'preview_protocol',
  });
});
