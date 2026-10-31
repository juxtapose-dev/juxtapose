import { afterEach, expect, it, vi } from 'vitest';
import { submitBuild } from './managed-submit.js';
const id = '019a0000-0000-7000-8000-000000000001';
const metadata = {
  requestId: id,
  sourceSha: 'a'.repeat(40),
  branch: 'main',
  archiveSha256: 'b'.repeat(64),
  archiveBytes: 100,
};
const config = { origin: 'https://api.juxtapose.dev', token: 'test-token' };
const receipt = (status = 'awaiting_upload') => ({
  build: {
    id,
    status,
    sourceSha: metadata.sourceSha,
    branch: metadata.branch,
    archiveSha256: metadata.archiveSha256,
    archiveBytes: 100,
    captureStatus: 'not_started',
    sourceVerified: false,
  },
  upload: {
    path: `/v1/builds/${id}/archive`,
    method: 'PUT',
    contentType: 'application/gzip',
  },
});
afterEach(() => vi.unstubAllGlobals());
it('submits exact bytes without treating the upload as capture success', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(receipt()))
    .mockResolvedValueOnce(Response.json(receipt('uploaded')));
  vi.stubGlobal('fetch', fetch);
  const result = await submitBuild(Buffer.alloc(100), metadata, config);
  expect(result.build.captureStatus).toBe('not_started');
  expect(result.build.status).toBe('uploaded');
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(metadata);
  expect(fetch.mock.calls[1]![0].toString()).toBe(
    `https://api.juxtapose.dev/v1/builds/${id}/archive`,
  );
  expect(Buffer.from(fetch.mock.calls[1]![1].body)).toEqual(Buffer.alloc(100));
  expect(fetch.mock.calls[1]![1].redirect).toBe('manual');
});
it('refuses foreign upload destinations before sending credentials', async () => {
  const body = receipt();
  body.upload.path = 'https://evil.invalid/archive';
  const fetch = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal('fetch', fetch);
  await expect(submitBuild(Buffer.alloc(100), metadata, config)).rejects.toThrow(
    /invalid.*receipt/i,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('explains disabled intake without claiming a passed review', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
  await expect(submitBuild(Buffer.alloc(100), metadata, config)).rejects.toThrow(
    /not enabled/i,
  );
});

it('rejects a receipt associated with a different pull request or branch', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(receipt('uploaded'))));
  await expect(
    submitBuild(Buffer.alloc(100), { ...metadata, pullRequestNumber: 42 }, config),
  ).rejects.toThrow(/Invalid build receipt/);
  await expect(
    submitBuild(Buffer.alloc(100), { ...metadata, branch: 'different' }, config),
  ).rejects.toThrow(/Invalid build receipt/);
});

const attemptId = '019a0000-0000-7000-8000-000000000002';
const preparePath = `/v1/builds/${id}/archive/direct/prepare`;
const finalizePath = `/v1/builds/${id}/archive/direct/finalize`;
function directReceipt(status = 'awaiting_upload') {
  const result = receipt(status);
  return {
    ...result,
    upload: {
      ...result.upload,
      direct: {
        schema: 'juxtapose.archive-upload/v1',
        preparePath,
        finalizePath,
      },
    },
  };
}
function prepared() {
  const issuedAtMs = Math.floor(Date.now() / 1000) * 1000;
  const date = new Date(issuedAtMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const url = new URL(
    `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/private-builds/attempt`,
  );
  for (const [key, value] of Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `TESTACCESSKEY123456/${date.slice(0, 8)}/auto/s3/aws4_request`,
    'X-Amz-Date': date,
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'content-length;content-type;host;if-none-match',
    'X-Amz-Signature': 'f'.repeat(64),
  }))
    url.searchParams.set(key, value);
  return {
    ...receipt('uploading'),
    directUpload: {
      schema: 'juxtapose.archive-upload-session/v1',
      attemptId,
      descriptor: {
        schema: 'juxtapose.direct-put/v1',
        method: 'PUT',
        url: url.href,
        bytes: 100,
        issuedAtMs,
        expiresAtMs: issuedAtMs + 300000,
        headers: {
          'content-type': 'application/gzip',
          'content-length': '100',
          'if-none-match': '*',
        },
      },
    },
  };
}
it('uploads directly without project credentials and returns only an accepted safe receipt', async () => {
  const session = prepared();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(directReceipt()))
    .mockResolvedValueOnce(Response.json(session))
    .mockResolvedValueOnce(new Response(null, { status: 412 }))
    .mockResolvedValueOnce(
      Response.json({ ...receipt('uploaded'), directUpload: session.directUpload }),
    );
  vi.stubGlobal('fetch', fetch);
  const result = await submitBuild(Buffer.alloc(100), metadata, config);
  expect(result).toEqual(receipt('uploaded'));
  expect(fetch.mock.calls[1]![0].toString()).toBe(config.origin + preparePath);
  expect(fetch.mock.calls[2]![0].toString()).toBe(session.directUpload.descriptor.url);
  expect(fetch.mock.calls[2]![1].headers).not.toHaveProperty('authorization');
  expect(fetch.mock.calls[2]![1].credentials).toBe('omit');
  expect(fetch.mock.calls[3]![0].toString()).toBe(config.origin + finalizePath);
  expect(JSON.parse(fetch.mock.calls[3]![1].body)).toEqual({ attemptId });
  expect(JSON.stringify(result)).not.toContain('X-Amz-');
});
it('rejects a malformed direct advertisement without legacy fallback', async () => {
  const value = directReceipt();
  value.upload.direct.preparePath = 'https://evil.invalid/prepare';
  const fetch = vi.fn().mockResolvedValue(Response.json(value));
  vi.stubGlobal('fetch', fetch);
  await expect(submitBuild(Buffer.alloc(100), metadata, config)).rejects.toThrow(
    /invalid/i,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reconciles an ambiguous failed PUT through finalization without proxy fallback', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(directReceipt()))
    .mockResolvedValueOnce(Response.json(prepared()))
    .mockRejectedValueOnce(new Error('private signed URL'))
    .mockRejectedValueOnce(new Error('private signed URL'))
    .mockRejectedValueOnce(new Error('private signed URL'))
    .mockResolvedValueOnce(Response.json(receipt('uploaded')));
  vi.stubGlobal('fetch', fetch);
  expect((await submitBuild(Buffer.alloc(100), metadata, config)).build.status).toBe(
    'uploaded',
  );
  expect(fetch.mock.calls[5]![0].toString()).toBe(config.origin + finalizePath);
});
it('retries a lost finalize response body with the same attempt', async () => {
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('lost body'));
      },
    }),
  );
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(directReceipt()))
    .mockResolvedValueOnce(Response.json(prepared()))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(broken)
    .mockResolvedValueOnce(Response.json(receipt('uploaded')));
  vi.stubGlobal('fetch', fetch);
  expect((await submitBuild(Buffer.alloc(100), metadata, config)).build.status).toBe(
    'uploaded',
  );
  expect(fetch.mock.calls[3]![1].body).toBe(fetch.mock.calls[4]![1].body);
});
it('retries a lost prepare body and does not upload again after an accepted prepare replay', async () => {
  const broken = new Response(
    new ReadableStream({
      start(c) {
        c.error(new Error('lost'));
      },
    }),
  );
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(directReceipt()))
    .mockResolvedValueOnce(broken)
    .mockResolvedValueOnce(Response.json(receipt('uploaded')));
  vi.stubGlobal('fetch', fetch);
  expect(await submitBuild(Buffer.alloc(100), metadata, config)).toEqual(
    receipt('uploaded'),
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[1]![0].toString()).toBe(fetch.mock.calls[2]![0].toString());
  expect(fetch.mock.calls[1]![1].body).toBe('{}');
});
it.each(['bad-session', 'bad-descriptor', 'malformed-json', 'unauthorized'] as const)(
  'rejects %s before external upload and never switches to proxy',
  async (kind) => {
    const session = prepared();
    if (kind === 'bad-session') session.directUpload.attemptId = 'invalid';
    if (kind === 'bad-descriptor')
      session.directUpload.descriptor.url = 'https://evil.invalid/';
    const response =
      kind === 'malformed-json'
        ? new Response('{')
        : kind === 'unauthorized'
          ? new Response(null, { status: 401 })
          : Response.json(session);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(directReceipt()))
      .mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetch);
    await expect(submitBuild(Buffer.alloc(100), metadata, config)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);
it('never accepts an incomplete finalized receipt', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(directReceipt()))
    .mockResolvedValueOnce(Response.json(prepared()))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(Response.json(receipt('uploading')));
  vi.stubGlobal('fetch', fetch);
  await expect(submitBuild(Buffer.alloc(100), metadata, config)).rejects.toThrow(
    /incomplete/i,
  );
  expect(fetch).toHaveBeenCalledTimes(4);
});
