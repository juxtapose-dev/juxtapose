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
