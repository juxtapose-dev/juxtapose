import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DirectPutError, putDirect } from './direct-put.js';

const issued = Date.parse('2026-10-31T12:00:00Z');
const signature = 'a'.repeat(64);
const secret = 'EXAMPLEACCESSKEY123';
const descriptor = () => {
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${secret}/20261031/auto/s3/aws4_request`,
    'X-Amz-Date': '20261031T120000Z',
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': 'content-length;content-type;host;if-none-match',
    'X-Amz-Signature': signature,
  });
  return {
    schema: 'juxtapose.direct-put/v1',
    method: 'PUT',
    url: `https://${'b'.repeat(32)}.r2.cloudflarestorage.com/archive/key?${query}`,
    bytes: 3,
    issuedAtMs: issued,
    expiresAtMs: issued + 900_000,
    headers: {
      'content-type': 'application/gzip',
      'content-length': '3',
      'if-none-match': '*',
    },
  };
};
const bytes = Uint8Array.of(1, 2, 3);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(issued + 1000);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([200, 204, 412])(
  'requires API finalization after PUT HTTP %i',
  async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(putDirect(descriptor(), bytes, 'application/gzip')).resolves.toEqual({
      requiresFinalization: true,
      putStatus: status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe(descriptor().url);
    expect(options).toMatchObject({
      method: 'PUT',
      redirect: 'error',
      credentials: 'omit',
      headers: descriptor().headers,
      body: bytes,
    });
    expect(Object.keys(options.headers).sort()).toEqual([
      'content-length',
      'content-type',
      'if-none-match',
    ]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  },
);

it.each([
  [
    'HTTP',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace('https:', 'http:');
    },
  ],
  [
    'foreign host',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace('.r2.cloudflarestorage.com', '.evil.invalid');
    },
  ],
  [
    'host suffix',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace('.com/', '.com.evil.invalid/');
    },
  ],
  [
    'user info',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace('https://', 'https://token@');
    },
  ],
  [
    'port',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace('.com/', '.com:8443/');
    },
  ],
  [
    'explicit default port',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace('.com/', '.com:443/');
    },
  ],
  [
    'fragment',
    (d: ReturnType<typeof descriptor>) => {
      d.url += '#secret';
    },
  ],
  [
    'duplicate query',
    (d: ReturnType<typeof descriptor>) => {
      d.url += `&X-Amz-Signature=${signature}`;
    },
  ],
  [
    'extra query',
    (d: ReturnType<typeof descriptor>) => {
      d.url += '&extra=secret';
    },
  ],
  [
    'missing query',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace(/&X-Amz-Signature=[^&]+/, '');
    },
  ],
  [
    'signature',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace(signature, 'short');
    },
  ],
  [
    'signed headers',
    (d: ReturnType<typeof descriptor>) => {
      d.url = d.url.replace('host%3B', 'authorization%3B');
    },
  ],
  [
    'date',
    (d: ReturnType<typeof descriptor>) => {
      d.issuedAtMs += 1000;
    },
  ],
  [
    'lifetime',
    (d: ReturnType<typeof descriptor>) => {
      d.expiresAtMs += 1000;
    },
  ],
  [
    'headers',
    (d: ReturnType<typeof descriptor>) => {
      Object.assign(d.headers, { authorization: 'Bearer private' });
    },
  ],
  [
    'schema',
    (d: ReturnType<typeof descriptor>) => {
      d.schema = 'unknown';
    },
  ],
  [
    'method',
    (d: ReturnType<typeof descriptor>) => {
      d.method = 'POST';
    },
  ],
  [
    'extra field',
    (d: ReturnType<typeof descriptor>) => {
      Object.assign(d, { token: 'private' });
    },
  ],
  [
    'length',
    (d: ReturnType<typeof descriptor>) => {
      d.bytes = 4;
    },
  ],
  [
    'content type',
    (d: ReturnType<typeof descriptor>) => {
      d.headers['content-type'] = 'text/plain';
    },
  ],
])(
  'rejects invalid %s before transport without disclosing capabilities',
  async (_label, mutate) => {
    const value = descriptor();
    mutate(value);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const error = await putDirect(value, bytes, 'application/gzip').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DirectPutError);
    expect(error).toMatchObject({ reason: 'invalid' });
    expect(String(error)).not.toMatch(/https:|EXAMPLEACCESS|Bearer|X-Amz|a{64}/);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('binds the capability to actual bytes and expected content type', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    putDirect(descriptor(), bytes.subarray(1), 'application/gzip'),
  ).rejects.toMatchObject({ reason: 'invalid' });
  await expect(putDirect(descriptor(), bytes, 'image/webp')).rejects.toMatchObject({
    reason: 'invalid',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([0, 16 * 1024 * 1024 + 1])(
  'rejects an actual %i-byte payload before transport',
  async (length) => {
    const value = descriptor();
    value.bytes = length;
    value.headers['content-length'] = String(length);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      putDirect(value, new Uint8Array(length), 'application/gzip'),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it('supports a bounded WebP capability and preserves a payload view offset', async () => {
  const value = descriptor();
  value.headers['content-type'] = 'image/webp';
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    putDirect(value, Uint8Array.of(9, 1, 2, 3, 8).subarray(1, 4), 'image/webp'),
  ).resolves.toMatchObject({ requiresFinalization: true });
  expect(fetch.mock.calls[0]![1].body).toEqual(bytes);
  expect(fetch.mock.calls[0]![1].headers['content-type']).toBe('image/webp');
});

it('does not send an expired capability', async () => {
  vi.setSystemTime(issued + 900_000);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(putDirect(descriptor(), bytes, 'application/gzip')).rejects.toMatchObject({
    reason: 'expired',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('retries ambiguous network/server failures with identical bytes and signed headers', async () => {
  const cancelled = vi.fn();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error(`provider leaked ${descriptor().url}`))
    .mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel: cancelled }), { status: 503 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 412 }));
  vi.stubGlobal('fetch', fetch);
  const result = putDirect(descriptor(), bytes, 'application/gzip').catch(
    (e: unknown) => e,
  );
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ requiresFinalization: true, putStatus: 412 });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(cancelled).toHaveBeenCalledOnce();
  for (const call of fetch.mock.calls) {
    expect(call[1].body).toEqual(bytes);
    expect(call[1].headers).toEqual(descriptor().headers);
  }
});

it.each([302, 400, 401, 403, 404, 429])(
  'does not retry HTTP %i or reveal its response body',
  async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(descriptor().url, { status }));
    vi.stubGlobal('fetch', fetch);
    const error = await putDirect(descriptor(), bytes, 'application/gzip').catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reason: 'failed' });
    expect(String(error)).not.toContain('https:');
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it('stops after three transient failures with a redacted CLI error', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error(descriptor().url));
  vi.stubGlobal('fetch', fetch);
  const outcome = putDirect(descriptor(), bytes, 'application/gzip').catch(
    (e: unknown) => e,
  );
  await vi.runAllTimersAsync();
  const error = await outcome;
  expect(error).toMatchObject({ reason: 'failed', exit: 1 });
  expect(String(error)).not.toMatch(/https:|X-Amz|EXAMPLEACCESS|a{64}/);
  expect(error).not.toHaveProperty('cause');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('limits each attempt to 60 seconds and stops retries at capability expiry', async () => {
  const aborts: number[] = [];
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => {
            aborts.push(Date.now());
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const value = descriptor();
  value.expiresAtMs = issued + 61_000;
  value.url = value.url.replace('X-Amz-Expires=900', 'X-Amz-Expires=61');
  const outcome = putDirect(value, bytes, 'application/gzip').catch((e: unknown) => e);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'expired' });
  expect(aborts).toEqual([issued + 61_000]);
  expect(fetch).toHaveBeenCalledOnce();
});

it('bounds every hung attempt even if transport ignores cancellation, and discards late bodies', async () => {
  const cancelled = vi.fn();
  const resolvers: ((response: Response) => void)[] = [];
  const fetch = vi.fn((_url: string, options: RequestInit) => {
    expect(options.signal!.aborted).toBe(false);
    return new Promise<Response>((resolve) => resolvers.push(resolve));
  });
  vi.stubGlobal('fetch', fetch);
  const outcome = putDirect(descriptor(), bytes, 'application/gzip').catch(
    (e: unknown) => e,
  );
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'failed' });
  expect(Date.now() - (issued + 1000)).toBe(180_750);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [index, resolve] of resolvers.entries()) {
    expect(fetch.mock.calls[index]![1].signal!.aborted).toBe(true);
    resolve(new Response(new ReadableStream({ cancel: cancelled })));
  }
  await Promise.resolve();
  expect(cancelled).toHaveBeenCalledTimes(3);
});

it('uses the shorter remaining capability lifetime and never starts an expired retry', async () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const value = descriptor();
  value.expiresAtMs = issued + 3000;
  value.url = value.url.replace('X-Amz-Expires=900', 'X-Amz-Expires=3');
  const outcome = putDirect(value, bytes, 'application/gzip').catch((e: unknown) => e);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ reason: 'expired' });
  expect(Date.now()).toBe(value.expiresAtMs);
  expect(fetch).toHaveBeenCalledOnce();
});

it('takes immutable bytes and header values before any retry awaits', async () => {
  const value = descriptor();
  const payload = Uint8Array.of(1, 2, 3);
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => {
      payload.fill(9);
      value.url = 'https://evil.invalid';
      Object.assign(value.headers, { authorization: 'Bearer private' });
      return Promise.resolve(new Response(null, { status: 500 }));
    })
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const outcome = putDirect(value, payload, 'application/gzip');
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ requiresFinalization: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetch.mock.calls) {
    expect(url).toBe(descriptor().url);
    expect(options.headers).toEqual(descriptor().headers);
    expect(options.body).toEqual(bytes);
  }
});

it.each([
  null,
  [],
  {},
  { ...descriptor(), issuedAtMs: Number.NaN },
  { ...descriptor(), expiresAtMs: Infinity },
  { ...descriptor(), issuedAtMs: issued + 0.5 },
  { ...descriptor(), url: `${descriptor().url}${'x'.repeat(4096)}` },
  { ...descriptor(), bytes: 16 * 1024 * 1024 + 1 },
])('rejects malformed descriptor shape or bounds without external I/O', async (value) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(putDirect(value, bytes, 'application/gzip')).rejects.toMatchObject({
    reason: 'invalid',
  });
  expect(fetch).not.toHaveBeenCalled();
});
