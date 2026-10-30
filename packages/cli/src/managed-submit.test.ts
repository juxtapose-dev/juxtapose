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
