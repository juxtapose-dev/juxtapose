import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadCommand } from './commands/upload.js';
import { runCommand } from './commands/run.js';
import { encodeStoryId } from '@juxtapose/core';
import { uploadConfig, uploadRun } from './hosted-upload.js';

let server: Server | undefined;
let dir: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  if (dir) await rm(dir, { recursive: true, force: true });
});
const id = 'button--primary__dark-mobile';
const runId = '00000000-0000-4000-8000-000000000001';
async function fixture() {
  dir = await mkdtemp(path.join(tmpdir(), 'jux-upload-'));
  await mkdir(path.join(dir, 'images'));
  await writeFile(
    path.join(dir, 'images', `${encodeStoryId(id)}-current.webp`),
    Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'),
  );
  const report = {
    runId: 'abc',
    branch: 'feature',
    commitSha: 'a'.repeat(40),
    startedAt: '2026-10-16T00:00:00Z',
    durationMs: 12,
    capturedCount: 1,
    totalCount: 10,
    summary: { pass: 0, fail: 1, new: 0, skip: 0, stale: 0 },
    results: [
      {
        storyId: id,
        status: 'fail',
        mismatchPixels: 1,
        mismatchPercent: 0.01,
        durationMs: 12,
        unstable: { hashes: ['one', 'two'] },
      },
    ],
  };
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
  return report;
}
type Reply = { status?: number; body?: unknown; location?: string; disconnect?: boolean };
async function serve(
  handler: (
    url: string,
    body: Buffer,
    headers: import('node:http').IncomingHttpHeaders,
  ) => Reply | Promise<Reply>,
) {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const result = await handler(req.url!, Buffer.concat(chunks), req.headers);
    if (result.disconnect) {
      req.socket.destroy();
      return;
    }
    res.writeHead(result.status ?? 200, {
      'content-type': 'application/json',
      ...(result.location ? { location: result.location } : {}),
    });
    res.end(JSON.stringify(result.body ?? {}));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${address.port}`, token: 'secret-test-token' };
}
describe('hosted uploads', () => {
  it('uploads a real multipart run preserving variants, local verdicts, and diagnostic evidence', async () => {
    const report = await fixture();
    const requests: string[] = [];
    const config = await serve((url, bytes, headers) => {
      requests.push(url);
      expect(headers.authorization).toBe('Bearer secret-test-token');
      if (url === '/v1/runs') {
        expect(JSON.parse(bytes.toString()).affectedStoryIds).toEqual([id]);
        return {
          body: {
            runId,
            snapshotPutUrlTemplate: `${config.origin}/snapshots/{storyIdSafe}`,
          },
        };
      }
      if (url.startsWith('/snapshots/')) {
        expect(headers['content-type']).toContain('multipart/form-data');
        expect(bytes.toString()).toContain(id);
        expect(bytes.toString()).toContain('name="current"');
        return { body: { deduped: true } };
      }
      const wire = JSON.parse(bytes.toString()).report;
      expect(wire.sourceReport).toEqual(report);
      expect(wire.totalCount).toBe(1);
      expect(wire.failCount).toBe(1);
      expect(wire.dedupedCount).toBe(1);
      expect(wire.snapshots[0].status).toBe('fail');
      return { body: { reportUrl: 'https://app.juxtapose.dev/review' } };
    });
    expect(await uploadRun(dir, config)).toEqual({
      runId,
      reportUrl: 'https://app.juxtapose.dev/review',
    });
    expect(requests).toHaveLength(3);
    expect(JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))).toEqual(
      report,
    );
  });
  it('refuses capture errors before making a remote run', async () => {
    const report = await fixture();
    await writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify({
        ...report,
        results: [{ ...report.results[0], error: 'capture failed' }],
      }),
    );
    await expect(
      uploadRun(dir, { origin: 'https://unused.invalid', token: 'secret' }),
    ).rejects.toThrow('errored captures');
  });
  it('never follows a redirect or echoes a response containing credentials', async () => {
    await fixture();
    let calls = 0;
    const config = await serve(() => {
      calls++;
      return { status: 307, location: '/stolen', body: { error: 'secret-test-token' } };
    });
    await expect(uploadRun(dir, config)).rejects.toThrow('redirect');
    expect(calls).toBe(1);
  });
  it('rejects a cross-origin upload URL before sending the token there', async () => {
    await fixture();
    const config = await serve(() => ({
      body: { runId, snapshotPutUrlTemplate: 'https://evil.invalid/{storyIdSafe}' },
    }));
    await expect(uploadRun(dir, config)).rejects.toThrow('unsafe upload URL');
  });
  it('validates token and HTTPS origin without logging secrets', () => {
    expect(() => uploadConfig({})).toThrow('JUXTAPOSE_TOKEN');
    for (const url of [
      'http://example.com',
      'https://user:pass@example.com',
      'https://example.com/path',
    ])
      expect(() =>
        uploadConfig({ JUXTAPOSE_TOKEN: 'secret', JUXTAPOSE_API_URL: url }),
      ).toThrow('HTTPS origin');
  });
  it('retries transient PUTs, sends pinned baseline evidence, and emits upload JSON', async () => {
    await fixture();
    await writeFile(
      path.join(dir, 'images', `${encodeStoryId(id)}-baseline.webp`),
      await readFile(path.join(dir, 'images', `${encodeStoryId(id)}-current.webp`)),
    );
    let puts = 0;
    const config = await serve((url, bytes) => {
      if (url === '/v1/runs')
        return {
          body: {
            runId,
            snapshotPutUrlTemplate: `${config.origin}/snapshots/{storyIdSafe}`,
          },
        };
      if (url.startsWith('/snapshots/')) {
        puts++;
        expect(bytes.toString()).toContain('name="baseline"');
        expect(bytes.toString()).toContain('baselineHash');
        return puts === 1 ? { status: 503 } : {};
      }
      return { body: { reportUrl: 'https://app.juxtapose.dev/review' } };
    });
    vi.stubEnv('JUXTAPOSE_TOKEN', config.token);
    vi.stubEnv('JUXTAPOSE_API_URL', config.origin);
    const out = vi.fn();
    expect(await uploadCommand({ run: dir, json: true }, { out, err: vi.fn() })).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0])).toEqual({
      runId,
      reportUrl: 'https://app.juxtapose.dev/review',
    });
    expect(puts).toBe(2);
  });

  it('validates credentials before resolving the workbench or launching capture', async () => {
    vi.stubEnv('JUXTAPOSE_TOKEN', '');
    await expect(
      runCommand({ upload: true, project: '/nonexistent-upload-project' }),
    ).rejects.toThrow('JUXTAPOSE_TOKEN');
  });
  it('retries create/finalize with identical bodies and does not retry quota or auth errors', async () => {
    await fixture();
    const bodies = new Map<string, string[]>();
    const config = await serve((url, bytes) => {
      const list = bodies.get(url) ?? [];
      list.push(bytes.toString());
      bodies.set(url, list);
      if (!url.startsWith('/snapshots/') && list.length === 1) return { status: 502 };
      if (url === '/v1/runs')
        return {
          body: {
            runId,
            snapshotPutUrlTemplate: `${config.origin}/snapshots/{storyIdSafe}`,
          },
        };
      return { body: { reportUrl: 'https://app.juxtapose.dev/review' } };
    });
    await uploadRun(dir, config);
    expect(bodies.get('/v1/runs')).toHaveLength(2);
    expect(new Set(bodies.get('/v1/runs')).size).toBe(1);
    expect(new Set(bodies.get(`/v1/runs/${runId}/finalize`)).size).toBe(1);
  });

  it.each([401, 429])(
    'does not retry HTTP %s or expose response secrets',
    async (status) => {
      await fixture();
      let calls = 0;
      const config = await serve(() => {
        calls++;
        return { status, body: { error: 'secret-test-token' } };
      });
      await expect(uploadRun(dir, config)).rejects.toThrow(`HTTP ${status}`);
      expect(calls).toBe(1);
    },
  );

  it('rejects changed artifacts before creating a run', async () => {
    const report = await fixture();
    await writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify({
        ...report,
        results: [{ ...report.results[0], hash: '0'.repeat(64) }],
      }),
    );
    await expect(
      uploadRun(dir, { origin: 'https://unused.invalid', token: 'secret' }),
    ).rejects.toThrow('report hash');
  });
  it('accepts a dimension-change failure and nullable review URL without losing the diagnostic', async () => {
    const report = await fixture();
    const bytes = await readFile(
      path.join(dir, 'images', `${encodeStoryId(id)}-current.webp`),
    );
    await writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify({
        ...report,
        results: [
          {
            ...report.results[0],
            hash: createHash('sha256').update(bytes).digest('hex'),
            error: 'viewport size changed since baseline',
          },
        ],
      }),
    );
    const config = await serve((url, body) => {
      if (url === '/v1/runs')
        return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
      if (url.endsWith('/finalize'))
        expect(JSON.parse(body.toString()).report.sourceReport.results[0].error).toBe(
          'viewport size changed since baseline',
        );
      return { body: { reportUrl: null } };
    });
    expect(await uploadRun(dir, config)).toEqual({ runId, reportUrl: null });
  });

  it.each([true, false])(
    'associates only matching PR commits (match=%s)',
    async (matches) => {
      const report = await fixture();
      await writeFile(
        path.join(dir, 'report.json'),
        JSON.stringify({ ...report, branch: 'HEAD' }),
      );
      const event = path.join(dir, 'event.json');
      await writeFile(
        event,
        JSON.stringify({
          number: 42,
          pull_request: {
            head: {
              sha: matches ? report.commitSha : 'b'.repeat(40),
              ref: 'feature/button',
            },
          },
        }),
      );
      vi.stubEnv('GITHUB_EVENT_PATH', event);
      vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
      vi.stubEnv('GITHUB_SHA', '');
      const config = await serve((url, body) => {
        if (url === '/v1/runs') {
          const request = JSON.parse(body.toString());
          expect(request.commitSha).toBe(report.commitSha);
          expect(request.prNumber).toBe(matches ? 42 : undefined);
          expect(request.branch).toBe(matches ? 'feature/button' : 'HEAD');
          return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
        }
        return { body: { reportUrl: null } };
      });
      await uploadRun(dir, config);
    },
  );
  it('recovers a lost create response using the identical external run identity', async () => {
    await fixture();
    const created: string[] = [];
    const config = await serve((url, bytes) => {
      if (url === '/v1/runs') {
        created.push(JSON.parse(bytes.toString()).runExternalId);
        if (created.length === 1) return { disconnect: true };
        return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
      }
      return { body: { reportUrl: null } };
    });
    expect((await uploadRun(dir, config)).runId).toBe(runId);
    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(1);
  });
  it('does not associate a pull_request_target base-branch capture using GITHUB_SHA', async () => {
    const report = await fixture();
    const event = path.join(dir, 'event.json');
    await writeFile(
      event,
      JSON.stringify({
        number: 42,
        pull_request: {
          head: { sha: 'b'.repeat(40), ref: 'feature/button' },
          merge_commit_sha: 'c'.repeat(40),
        },
      }),
    );
    vi.stubEnv('GITHUB_EVENT_PATH', event);
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request_target');
    vi.stubEnv('GITHUB_SHA', report.commitSha);
    const config = await serve((url, body) => {
      if (url === '/v1/runs') {
        expect(JSON.parse(body.toString()).prNumber).toBeUndefined();
        return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
      }
      return { body: { reportUrl: null } };
    });
    await uploadRun(dir, config);
  });
  it('uploads skipped captures as metadata only despite invalid leftover images', async () => {
    const report = await fixture();
    await writeFile(
      path.join(dir, 'report.json'),
      JSON.stringify({
        ...report,
        summary: { pass: 0, fail: 0, new: 0, skip: 1, stale: 0 },
        results: [
          {
            storyId: id,
            status: 'skip',
            mismatchPixels: 0,
            mismatchPercent: 0,
            durationMs: 0,
          },
        ],
      }),
    );
    for (const suffix of ['current', 'diff', 'baseline']) {
      await writeFile(
        path.join(dir, 'images', `${encodeStoryId(id)}-${suffix}.webp`),
        'invalid leftover image',
      );
    }
    const config = await serve((url, bytes) => {
      if (url === '/v1/runs')
        return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
      if (url.startsWith('/snapshots/')) {
        const multipart = bytes.toString();
        expect(multipart).toContain('name="meta"');
        expect(multipart).toContain('"status":"skipped"');
        expect(multipart).not.toContain('baselineHash');
        for (const part of ['current', 'diff', 'baseline', 'thumb'])
          expect(multipart).not.toContain(`name="${part}"`);
      } else {
        const wire = JSON.parse(bytes.toString()).report;
        expect(wire.skippedCount).toBe(1);
        expect(wire.snapshots[0].contentHash).toBeNull();
      }
      return { body: { reportUrl: null } };
    });
    expect(await uploadRun(dir, config)).toEqual({ runId, reportUrl: null });
  });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function parallelFixture(count: number) {
  const report = await fixture();
  const bytes = await readFile(
    path.join(dir, 'images', `${encodeStoryId(id)}-current.webp`),
  );
  const results = Array.from({ length: count }, (_, index) => ({
    ...report.results[0]!,
    storyId: `button--parallel-${index}`,
  }));
  for (const result of results)
    await writeFile(
      path.join(dir, 'images', `${encodeStoryId(result.storyId)}-current.webp`),
      bytes,
    );
  const next = {
    ...report,
    capturedCount: count,
    totalCount: count,
    results,
    summary: { ...report.summary, fail: count },
  };
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(next));
  return next;
}
it('overlaps at most four snapshot uploads and finalizes only after every response', async () => {
  await parallelFixture(9);
  let active = 0,
    maximum = 0,
    completed = 0;
  const progress: string[] = [];
  const config = await serve(async (url, bytes) => {
    if (url === '/v1/runs')
      return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
    if (url.startsWith('/snapshots/')) {
      active++;
      maximum = Math.max(maximum, active);
      await pause(25);
      active--;
      completed++;
      return { body: { deduped: true } };
    }
    expect(active).toBe(0);
    expect(completed).toBe(9);
    expect(JSON.parse(bytes.toString()).report.dedupedCount).toBe(9);
    return { body: { reportUrl: null } };
  });
  await uploadRun(dir, config, (message) => progress.push(message));
  expect(maximum).toBe(4);
  expect(progress.some((message) => message.includes('0/9'))).toBe(true);
  expect(progress.some((message) => message.includes('9/9'))).toBe(true);
  expect(progress.at(-1)).toContain('finalizing');
});
it('drains in-flight uploads on failure, stops scheduling and never finalizes', async () => {
  const report = await parallelFixture(9);
  let active = 0,
    started = 0,
    completed = 0,
    finalized = false;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const config = await serve(async (url) => {
    if (url === '/v1/runs')
      return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
    if (url.startsWith('/snapshots/')) {
      const order = ++started;
      active++;
      if (started === 4) release();
      if (order === 1) {
        await Promise.race([entered, pause(100)]);
        active--;
        return { status: 401 };
      }
      await pause(60);
      active--;
      completed++;
      return {};
    }
    finalized = true;
    return { body: { reportUrl: null } };
  });
  await expect(uploadRun(dir, config)).rejects.toThrow('HTTP 401');
  expect(started).toBe(4);
  expect(active).toBe(0);
  expect(completed).toBe(3);
  expect(finalized).toBe(false);
  expect(JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))).toEqual(
    report,
  );
});
it('retries within a worker without double-counting successful progress or final counts', async () => {
  await parallelFixture(6);
  const attempts = new Map<string, number>();
  let retryUrl = '';
  const progress: string[] = [];
  const config = await serve((url, bytes) => {
    if (url === '/v1/runs')
      return { body: { runId, snapshotPutUrlTemplate: '/snapshots/{storyIdSafe}' } };
    if (url.startsWith('/snapshots/')) {
      if (!retryUrl) retryUrl = url;
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      if (url === retryUrl && attempt === 1) return { status: 503 };
      return { body: { deduped: true } };
    }
    expect(JSON.parse(bytes.toString()).report.dedupedCount).toBe(6);
    return { body: { reportUrl: null } };
  });
  await uploadRun(dir, config, (message) => progress.push(message));
  expect(attempts.get(retryUrl)).toBe(2);
  expect(progress.filter((message) => message.startsWith('jux: uploaded '))).toHaveLength(
    6,
  );
  expect(progress.some((message) => message.includes('6/6'))).toBe(true);
});

const protocol = {
  version: 1,
  probePath: `/v1/runs/${runId}/artifacts/probe`,
  batchPath: `/v1/runs/${runId}/snapshots/batch`,
  maxItems: 16,
  maxBlobs: 32,
  maxRequestBytes: 8388608,
  maxArtifactBytes: 1048576,
  maxProbeItems: 256,
};
type BatchItem = {
  storyIdSafe: string;
  meta: { storyId: string; contentHash: string };
  artifacts: Record<string, { hash: string; bytes: number }>;
};
async function batchForm(
  bytes: Buffer,
  headers: import('node:http').IncomingHttpHeaders,
) {
  const form = await new Response(new Uint8Array(bytes), {
    headers: { 'content-type': headers['content-type']! },
  }).formData();
  return {
    form,
    items: (JSON.parse(String(form.get('manifest'))) as { items: BatchItem[] }).items,
  };
}
const success = (item: BatchItem) => ({
  storyIdSafe: item.storyIdSafe,
  status: 201,
  snapshotId: `00000000-0000-4000-8000-${item.storyIdSafe.slice(0, 12)}`,
  deduped: true,
  retryable: false,
});
const createBatchRun = () => ({
  body: {
    runId,
    snapshotPutUrlTemplate: '/legacy/{storyIdSafe}',
    uploadProtocol: protocol,
  },
});

it('uses advertised verified hash reuse without re-sending cached WebP bytes', async () => {
  const report = await parallelFixture(3);
  let batchItems = 0,
    finalized = false;
  const config = await serve(async (url, bytes, headers) => {
    if (url === '/v1/runs') return createBatchRun();
    if (url === protocol.probePath) {
      const artifacts = JSON.parse(bytes.toString()).artifacts;
      expect(artifacts).toHaveLength(1);
      return { body: { available: artifacts, missing: [] } };
    }
    if (url === protocol.batchPath) {
      const { form, items } = await batchForm(bytes, headers);
      expect([...form.keys()]).toEqual(['manifest']);
      expect(items.map((item) => item.meta.storyId)).toEqual(
        report.results.map((result) => result.storyId),
      );
      expect(
        items.every(
          (item) => item.artifacts.current?.hash === item.artifacts.thumb?.hash,
        ),
      ).toBe(true);
      batchItems += items.length;
      return { body: { results: items.map(success) } };
    }
    if (url.endsWith('/finalize')) {
      finalized = true;
      expect(batchItems).toBe(3);
      return { body: { reportUrl: null } };
    }
    return { status: 418 };
  });
  await expect(uploadRun(dir, config)).resolves.toEqual({ runId, reportUrl: null });
  expect(finalized).toBe(true);
});

it.each(['items', 'bytes', 'blobs'] as const)(
  'bounds real batch requests by %s before finalizing',
  async (mode) => {
    const count = mode === 'items' ? 17 : mode === 'bytes' ? 9 : 12;
    const report = await parallelFixture(count);
    if (mode !== 'items') {
      for (const [index, result] of report.results.entries()) {
        for (const role of mode === 'bytes'
          ? ['current']
          : ['current', 'diff', 'baseline']) {
          const data = Buffer.alloc(mode === 'bytes' ? 1048576 : 64, index + role.length);
          data.write('RIFF', 0);
          data.write('WEBP', 8);
          data.write(`${index}-${role}`, 16);
          await writeFile(
            path.join(dir, 'images', `${encodeStoryId(result.storyId)}-${role}.webp`),
            data,
          );
        }
      }
    }
    let batches = 0,
      uploaded = 0;
    const config = await serve(async (url, bytes, headers) => {
      if (url === '/v1/runs') return createBatchRun();
      if (url === protocol.probePath)
        return {
          body: { available: [], missing: JSON.parse(bytes.toString()).artifacts },
        };
      if (url === protocol.batchPath) {
        batches++;
        expect(bytes.length).toBeLessThanOrEqual(protocol.maxRequestBytes);
        const { form, items } = await batchForm(bytes, headers);
        expect(items.length).toBeLessThanOrEqual(protocol.maxItems);
        expect(
          [...form.keys()].filter((key) => key.startsWith('blob:')).length,
        ).toBeLessThanOrEqual(protocol.maxBlobs);
        uploaded += items.length;
        return { body: { results: items.map(success) } };
      }
      if (url.endsWith('/finalize')) {
        expect(uploaded).toBe(count);
        return { body: { reportUrl: null } };
      }
      return { status: 418 };
    });
    await uploadRun(dir, config);
    expect(batches).toBe(2);
  },
);

it.each(['missing', 'transient', 'server500'] as const)(
  'retries only failed batch items after %s failures',
  async (mode) => {
    await parallelFixture(3);
    const batches: string[][] = [];
    let missingHash = '';
    const progress: string[] = [];
    const config = await serve(async (url, bytes, headers) => {
      if (url === '/v1/runs') return createBatchRun();
      if (url === protocol.probePath)
        return {
          body: { available: JSON.parse(bytes.toString()).artifacts, missing: [] },
        };
      if (url === protocol.batchPath) {
        const { form, items } = await batchForm(bytes, headers);
        batches.push(items.map((item) => item.storyIdSafe));
        if (batches.length === 1) {
          expect([...form.keys()]).toEqual(['manifest']);
          missingHash = items[0]!.artifacts.current!.hash;
          return {
            body: {
              results: [
                {
                  storyIdSafe: items[0]!.storyIdSafe,
                  status: mode === 'missing' ? 409 : mode === 'server500' ? 500 : 503,
                  error: mode === 'missing' ? 'missing_artifacts' : 'temporary_failure',
                  ...(mode === 'missing' ? { missingHashes: [missingHash] } : {}),
                  retryable: true,
                },
                ...items.slice(1).map(success),
              ],
            },
          };
        }
        expect(items).toHaveLength(1);
        expect(form.has(`blob:${missingHash}`)).toBe(mode === 'missing');
        return { body: { results: items.map(success) } };
      }
      if (url.endsWith('/finalize')) {
        expect(JSON.parse(bytes.toString()).report.dedupedCount).toBe(3);
        return { body: { reportUrl: null } };
      }
      return { status: 418 };
    });
    await uploadRun(dir, config, (message) => progress.push(message));
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([batches[0]![0]]);
    expect(
      progress.filter((message) => message.startsWith('jux: uploaded ')),
    ).toHaveLength(3);
  },
);

it.each([
  'auth',
  'malformed-probe',
  'unrequested-probe',
  'missing-receipt',
  'duplicate-snapshot',
  'terminal-item',
] as const)(
  'fails closed on %s without legacy fallback or finalization',
  async (mode) => {
    const report = await parallelFixture(2);
    let finalized = false,
      legacy = false;
    const config = await serve(async (url, bytes, headers) => {
      if (url === '/v1/runs') return createBatchRun();
      if (url.startsWith('/legacy/')) {
        legacy = true;
        return { status: 418 };
      }
      if (url === protocol.probePath) {
        if (mode === 'auth') return { status: 403 };
        if (mode === 'unrequested-probe')
          return { body: { available: [{ hash: 'f'.repeat(64) }], missing: [] } };
        return {
          body:
            mode === 'malformed-probe'
              ? { available: [], missing: [] }
              : { available: JSON.parse(bytes.toString()).artifacts, missing: [] },
        };
      }
      if (url === protocol.batchPath) {
        const { items } = await batchForm(bytes, headers);
        return {
          body: {
            results:
              mode === 'missing-receipt'
                ? []
                : mode === 'duplicate-snapshot'
                  ? items.map((item) => ({ ...success(item), snapshotId: runId }))
                  : items.map((item) => ({
                      storyIdSafe: item.storyIdSafe,
                      status: 409,
                      error: 'snapshot_conflict',
                      retryable: false,
                    })),
          },
        };
      }
      finalized = true;
      return { body: { reportUrl: null } };
    });
    await expect(uploadRun(dir, config)).rejects.toThrow();
    expect(legacy).toBe(false);
    expect(finalized).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))).toEqual(
      report,
    );
  },
);

it.each([
  null,
  { ...protocol, version: 2 },
  { ...protocol, probePath: 'https://attacker.invalid/' },
  { ...protocol, maxRequestBytes: 16777216 },
])(
  'does not fall back when advertised capabilities are malformed or unsupported',
  async (advertised) => {
    await fixture();
    let calls = 0;
    const config = await serve(() => {
      calls++;
      return { body: { ...createBatchRun().body, uploadProtocol: advertised } };
    });
    await expect(uploadRun(dir, config)).rejects.toThrow('invalid batch');
    expect(calls).toBe(1);
  },
);
it('overlaps at most four bounded batches and waits for all receipts before finalization', async () => {
  await parallelFixture(65);
  let active = 0,
    maximum = 0,
    completed = 0;
  const config = await serve(async (url, bytes, headers) => {
    if (url === '/v1/runs') return createBatchRun();
    if (url === protocol.probePath)
      return { body: { available: JSON.parse(bytes.toString()).artifacts, missing: [] } };
    if (url === protocol.batchPath) {
      const { items } = await batchForm(bytes, headers);
      active++;
      maximum = Math.max(maximum, active);
      await pause(30);
      active--;
      completed += items.length;
      return { body: { results: items.map(success) } };
    }
    if (url.endsWith('/finalize')) {
      expect(active).toBe(0);
      expect(completed).toBe(65);
      return { body: { reportUrl: null } };
    }
    return { status: 418 };
  });
  await uploadRun(dir, config);
  expect(maximum).toBe(4);
});
it.each(['success', 'retryable'] as const)(
  'drains active batches after a terminal request failure without scheduling %s follow-up work',
  async (mode) => {
    await parallelFixture(65);
    let active = 0,
      started = 0,
      completed = 0,
      finalized = false;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const config = await serve(async (url, bytes, headers) => {
      if (url === '/v1/runs') return createBatchRun();
      if (url === protocol.probePath)
        return {
          body: { available: JSON.parse(bytes.toString()).artifacts, missing: [] },
        };
      if (url === protocol.batchPath) {
        const { items } = await batchForm(bytes, headers);
        const order = ++started;
        active++;
        if (started === 4) release();
        if (order === 1) {
          await Promise.race([entered, pause(100)]);
          active--;
          return { status: 401 };
        }
        await pause(60);
        active--;
        completed++;
        return {
          body: {
            results:
              mode === 'success'
                ? items.map(success)
                : items.map((item) => ({
                    storyIdSafe: item.storyIdSafe,
                    status: 500,
                    error: 'upload_failed',
                    retryable: true,
                  })),
          },
        };
      }
      finalized = true;
      return { body: { reportUrl: null } };
    });
    await expect(uploadRun(dir, config)).rejects.toThrow('HTTP 401');
    expect(started).toBe(4);
    expect(active).toBe(0);
    expect(completed).toBe(3);
    expect(finalized).toBe(false);
  },
);
it('exhausts bounded per-item retries without publishing an incomplete result', async () => {
  await parallelFixture(2);
  let batches = 0,
    finalized = false;
  const config = await serve(async (url, bytes, headers) => {
    if (url === '/v1/runs') return createBatchRun();
    if (url === protocol.probePath)
      return { body: { available: JSON.parse(bytes.toString()).artifacts, missing: [] } };
    if (url === protocol.batchPath) {
      batches++;
      const { items } = await batchForm(bytes, headers);
      return {
        body: {
          results: items.map((item) => ({
            storyIdSafe: item.storyIdSafe,
            status: 503,
            error: 'temporary_failure',
            retryable: true,
          })),
        },
      };
    }
    finalized = true;
    return { body: { reportUrl: null } };
  });
  await expect(uploadRun(dir, config)).rejects.toThrow('retries exhausted');
  expect(batches).toBe(3);
  expect(finalized).toBe(false);
});
it('rejects local byte changes after a missing-hash probe before sending a batch', async () => {
  const report = await parallelFixture(1);
  let batchCalls = 0,
    finalized = false;
  const config = await serve(async (url, bytes) => {
    if (url === '/v1/runs') return createBatchRun();
    if (url === protocol.probePath) {
      const file = path.join(
        dir,
        'images',
        `${encodeStoryId(report.results[0]!.storyId)}-current.webp`,
      );
      const changed = await readFile(file);
      changed[changed.length - 1] ^= 1;
      await writeFile(file, changed);
      return { body: { available: [], missing: JSON.parse(bytes.toString()).artifacts } };
    }
    if (url === protocol.batchPath) {
      batchCalls++;
      return { body: { results: [] } };
    }
    finalized = true;
    return { body: { reportUrl: null } };
  });
  await expect(uploadRun(dir, config)).rejects.toThrow('artifacts changed');
  expect(batchCalls).toBe(0);
  expect(finalized).toBe(false);
});

it('repartitions cache-eviction retries when newly missing blobs exceed one batch', async () => {
  const report = await parallelFixture(12);
  for (const [index, result] of report.results.entries())
    for (const role of ['current', 'diff', 'baseline']) {
      const data = Buffer.alloc(64, index);
      data.write('RIFF', 0);
      data.write('WEBP', 8);
      data.write(`${index}-${role}`, 16);
      await writeFile(
        path.join(dir, 'images', `${encodeStoryId(result.storyId)}-${role}.webp`),
        data,
      );
    }
  const sizes: number[] = [];
  let calls = 0;
  const config = await serve(async (url, bytes, headers) => {
    if (url === '/v1/runs') return createBatchRun();
    if (url === protocol.probePath)
      return { body: { available: JSON.parse(bytes.toString()).artifacts, missing: [] } };
    if (url === protocol.batchPath) {
      calls++;
      const { form, items } = await batchForm(bytes, headers);
      if (calls === 1) {
        expect(items).toHaveLength(12);
        expect([...form.keys()]).toEqual(['manifest']);
        return {
          body: {
            results: items.map((item) => ({
              storyIdSafe: item.storyIdSafe,
              status: 409,
              error: 'missing_artifacts',
              missingHashes: [
                ...new Set(Object.values(item.artifacts).map((ref) => ref.hash)),
              ],
              retryable: true,
            })),
          },
        };
      }
      sizes.push([...form.keys()].filter((key) => key.startsWith('blob:')).length);
      expect(bytes.length).toBeLessThanOrEqual(protocol.maxRequestBytes);
      return { body: { results: items.map(success) } };
    }
    if (url.endsWith('/finalize')) return { body: { reportUrl: null } };
    return { status: 418 };
  });
  await uploadRun(dir, config);
  expect(calls).toBe(3);
  expect(sizes).toEqual([30, 6]);
});
it('chunks verified hash probes within advertised item and JSON byte limits', async () => {
  const report = await parallelFixture(257);
  for (const [index, result] of report.results.entries()) {
    const data = Buffer.alloc(64);
    data.write('RIFF', 0);
    data.write('WEBP', 8);
    data.write(String(index), 16);
    await writeFile(
      path.join(dir, 'images', `${encodeStoryId(result.storyId)}-current.webp`),
      data,
    );
  }
  let probes = 0,
    completed = 0;
  const config = await serve(async (url, bytes, headers) => {
    if (url === '/v1/runs') return createBatchRun();
    if (url === protocol.probePath) {
      probes++;
      const { artifacts } = JSON.parse(bytes.toString());
      expect(artifacts.length).toBeLessThanOrEqual(256);
      expect(bytes.length).toBeLessThanOrEqual(32768);
      return { body: { available: artifacts, missing: [] } };
    }
    if (url === protocol.batchPath) {
      const { form, items } = await batchForm(bytes, headers);
      expect([...form.keys()]).toEqual(['manifest']);
      completed += items.length;
      return { body: { results: items.map(success) } };
    }
    if (url.endsWith('/finalize')) {
      expect(completed).toBe(257);
      return { body: { reportUrl: null } };
    }
    return { status: 418 };
  });
  await uploadRun(dir, config);
  expect(probes).toBe(2);
});

it('sends skipped batch items without hashing or uploading stale leftover images', async () => {
  const report = await fixture();
  await writeFile(
    path.join(dir, 'report.json'),
    JSON.stringify({
      ...report,
      results: [
        { ...report.results[0], status: 'skip', mismatchPixels: 0, mismatchPercent: 0 },
      ],
      summary: { ...report.summary, fail: 0, skip: 1 },
    }),
  );
  await writeFile(
    path.join(dir, 'images', `${encodeStoryId(id)}-current.webp`),
    'invalid leftover',
  );
  let probes = 0;
  const config = await serve(async (url, bytes, headers) => {
    if (url === '/v1/runs') return createBatchRun();
    if (url === protocol.probePath) {
      probes++;
      return { body: { available: [], missing: [] } };
    }
    if (url === protocol.batchPath) {
      const { form, items } = await batchForm(bytes, headers);
      expect([...form.keys()]).toEqual(['manifest']);
      expect(items[0]!.artifacts).toEqual({});
      expect((items[0]!.meta as Record<string, unknown>).status).toBe('skipped');
      return {
        body: { results: items.map((item) => ({ ...success(item), deduped: false })) },
      };
    }
    if (url.endsWith('/finalize')) {
      const wire = JSON.parse(bytes.toString()).report;
      expect(wire.skippedCount).toBe(1);
      expect(wire.dedupedCount).toBe(0);
      expect(wire.snapshots[0].contentHash).toBeNull();
      return { body: { reportUrl: null } };
    }
    return { status: 418 };
  });
  await uploadRun(dir, config);
  expect(probes).toBe(0);
});
