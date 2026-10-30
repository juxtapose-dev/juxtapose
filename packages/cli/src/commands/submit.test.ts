import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { submitCommand } from './submit.js';
import { captureIo } from '../io.js';
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it('round trips a compiled fixture and retains the request ID across command retries', async () => {
  vi.stubEnv('GITHUB_REF', 'refs/heads/main');
  const root = await mkdtemp(path.join(tmpdir(), 'jux-submit-'));
  dirs.push(root);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  await writeFile(path.join(root, 'source.txt'), 'committed source');
  git(['add', 'source.txt']);
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  const buildDir = path.join(root, 'storybook-static');
  await mkdir(buildDir);
  for (const name of ['index.html', 'iframe.html', 'index.json'])
    await writeFile(
      path.join(buildDir, name),
      name.endsWith('json') ? '{}' : '<h1>Story</h1>',
    );
  const requests: Record<string, unknown>[] = [];
  let uploaded: Buffer | undefined;
  let waitVerdict = 'needs_review';
  let waiting = false;
  let trackResume = false;
  const resumeRequests: string[] = [];
  const id = '019a0000-0000-7000-8000-000000000001';
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    if (trackResume) resumeRequests.push(`${req.method} ${req.url}`);
    if (waitVerdict === 'paused' && req.method !== 'GET') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    if (req.url === `/v1/builds/${id}/capture`) {
      waiting = true;
      res.statusCode = 202;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          capture: { buildId: id, status: 'ready', jobId: id, error: null },
        }),
      );
      return;
    }
    if (req.url === `/v1/builds/${id}/status`) {
      const input = requests.at(-1)!;
      if (waitVerdict === 'paused') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            schema: 'juxtapose.managed-status/v1',
            buildId: id,
            sourceSha: input.sourceSha,
            phase: 'capture',
            terminal: true,
            reason: 'execution_disabled',
            recovery: 'operator',
            retryAfterMs: 2000,
            validation: { status: 'ready' },
            execution: { status: 'queued' },
            comparison: { status: 'not_started' },
            publication: { status: 'not_started' },
            review: { state: 'pending', runId: null, url: null, verdict: 'incomplete' },
          }),
        );
        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          schema: 'juxtapose.managed-status/v1',
          buildId: id,
          sourceSha: input.sourceSha,
          phase:
            waitVerdict === 'baseline'
              ? 'baseline'
              : waitVerdict === 'reference'
                ? 'reference'
                : 'review',
          terminal: true,
          reason:
            waitVerdict === 'baseline'
              ? 'baseline_missing'
              : waitVerdict === 'reference'
                ? 'reference_only'
                : null,
          recovery: waitVerdict === 'baseline' ? 'capture_baseline' : 'none',
          retryAfterMs: 250,
          validation: { status: 'ready' },
          execution: { status: 'completed' },
          comparison: {
            status: waitVerdict === 'reference' ? 'not_started' : 'completed',
          },
          publication: {
            status:
              waitVerdict === 'reference'
                ? 'not_started'
                : waitVerdict === 'unpublished'
                  ? 'running'
                  : 'completed',
          },
          review: {
            state:
              waitVerdict === 'reference'
                ? 'reference'
                : waitVerdict === 'baseline'
                  ? 'blocked'
                  : 'ready',
            runId: ['baseline', 'reference'].includes(waitVerdict) ? null : id,
            url: ['baseline', 'reference'].includes(waitVerdict)
              ? null
              : waitVerdict === 'missing_url'
                ? null
                : `https://app.juxtapose.dev/acme/app/runs/${id}`,
            verdict: ['baseline', 'reference'].includes(waitVerdict)
              ? 'incomplete'
              : ['unpublished', 'missing_url'].includes(waitVerdict)
                ? 'needs_review'
                : waitVerdict,
          },
        }),
      );
      return;
    }

    if (req.method === 'POST') requests.push(JSON.parse(body.toString()));
    else uploaded = body;
    const input = requests.at(-1)!;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        build: {
          id,
          status: req.method === 'POST' ? 'awaiting_upload' : 'uploaded',
          sourceSha: input.sourceSha,
          branch: input.branch,
          pullRequestNumber: input.pullRequestNumber ?? null,
          archiveSha256: input.archiveSha256,
          archiveBytes: input.archiveBytes,
          captureStatus: 'not_started',
          sourceVerified: false,
        },
        upload: {
          path: `/v1/builds/${id}/archive`,
          method: 'PUT',
          contentType: 'application/gzip',
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  vi.stubEnv('JUXTAPOSE_API_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('JUXTAPOSE_TOKEN', 'test-token');
  try {
    const io = captureIo();
    const flags = {
      project: root,
      'build-dir': 'storybook-static',
      branch: 'main',
      experimental: true,
      json: true,
    };
    expect(await submitCommand(flags, io)).toBe(0);
    expect(await submitCommand(flags, captureIo())).toBe(0);
    expect(requests[0]).toEqual(requests[1]);
    vi.stubEnv('GITHUB_REF', 'refs/pull/42/merge');
    expect(await submitCommand(flags, captureIo())).toBe(0);
    expect(requests[2]!.pullRequestNumber).toBe(42);
    expect(requests[2]!.requestId).not.toBe(requests[0]!.requestId);
    expect(await submitCommand(flags, captureIo())).toBe(0);
    expect(requests[3]).toEqual(requests[2]);
    expect(await submitCommand({ ...flags, pr: '77' }, captureIo())).toBe(0);
    expect(requests[4]!.pullRequestNumber).toBe(77);
    expect(requests[4]!.requestId).not.toBe(requests[2]!.requestId);
    await expect(submitCommand({ ...flags, pr: '1.5' }, captureIo())).rejects.toThrow(
      /positive pull request/,
    );
    expect(createHash('sha256').update(uploaded!).digest('hex')).toBe(
      requests[0]!.archiveSha256,
    );
    expect(waiting).toBe(false);
    const completed = captureIo();
    expect(
      await submitCommand({ ...flags, wait: true, 'wait-timeout': '5000' }, completed),
    ).toBe(1);
    expect(JSON.parse(completed.stdout()).workflow.review).toMatchObject({
      verdict: 'needs_review',
      runId: id,
    });
    for (const verdict of ['needs_review', 'rejected']) {
      waitVerdict = verdict;
      const handoff = captureIo();
      expect(
        await submitCommand({ ...flags, wait: true, 'review-in-github': true }, handoff),
      ).toBe(0);
      expect(JSON.parse(handoff.stdout()).handoff).toEqual({
        status: 'published',
        reviewUrl: `https://app.juxtapose.dev/acme/app/runs/${id}`,
        approval: 'required_app_check',
      });
    }
    waitVerdict = 'unchanged';
    expect(await submitCommand({ ...flags, wait: true }, captureIo())).toBe(0);
    waitVerdict = 'reference';
    expect(await submitCommand({ ...flags, wait: true }, captureIo())).toBe(0);
    const reference = captureIo();
    expect(
      await submitCommand({ ...flags, wait: true, 'review-in-github': true }, reference),
    ).toBe(0);
    expect(JSON.parse(reference.stdout()).workflow.review.state).toBe('reference');
    expect(JSON.parse(reference.stdout()).handoff).toBeUndefined();
    waitVerdict = 'baseline';
    expect(await submitCommand({ ...flags, wait: true }, captureIo())).toBe(1);
    expect(
      await submitCommand(
        { ...flags, wait: true, 'review-in-github': true },
        captureIo(),
      ),
    ).toBe(1);
    waitVerdict = 'paused';
    expect(
      await submitCommand(
        { experimental: true, resume: id, 'review-in-github': true },
        captureIo(),
      ),
    ).toBe(3);
    for (const mode of ['unpublished', 'missing_url']) {
      waitVerdict = mode;
      const invalid = captureIo();
      expect(
        await submitCommand({ ...flags, wait: true, 'review-in-github': true }, invalid),
      ).toBe(3);
      expect(JSON.parse(invalid.stdout()).handoff).toBeUndefined();
    }
    waitVerdict = 'needs_review';
    const built = spawn(
      process.execPath,
      [
        path.resolve(import.meta.dirname, '../../dist/index.js'),
        'submit',
        '--project',
        root,
        '--build-dir',
        'storybook-static',
        '--branch',
        'main',
        '--experimental',
        '--wait',
        '--wait-timeout',
        '5000',
        '--json',
      ],
      { env: { ...process.env } },
    );
    let stdout = '',
      stderr = '';
    built.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    built.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve) => built.on('exit', resolve));
    expect(code, stderr).toBe(1);
    expect(JSON.parse(stdout).workflow.review.verdict).toBe('needs_review');
    trackResume = true;
    for (const expected of [
      { mode: 'unchanged', exit: 0 },
      { mode: 'paused', exit: 3 },
      { mode: 'needs_review', exit: 0 },
      { mode: 'baseline', exit: 1 },
    ]) {
      waitVerdict = expected.mode;
      const child = spawn(
        process.execPath,
        [
          path.resolve(import.meta.dirname, '../../dist/index.js'),
          'submit',
          '--experimental',
          '--resume',
          id,
          '--review-in-github',
          '--json',
        ],
        { cwd: tmpdir(), env: { ...process.env } },
      );
      let output = '',
        errors = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        errors += String(chunk);
      });
      const exit = await new Promise<number | null>((resolve) =>
        child.on('exit', resolve),
      );
      expect(exit, errors).toBe(expected.exit);
      const value = JSON.parse(output);
      expect(value.buildId).toBe(id);
      expect(value.workflow.buildId).toBe(id);
      if (expected.mode === 'paused')
        expect(value.workflow).toMatchObject({
          reason: 'execution_disabled',
          execution: { status: 'queued' },
          review: { verdict: 'incomplete' },
        });
    }
    expect(resumeRequests).toEqual([
      `GET /v1/builds/${id}/status`,
      `GET /v1/builds/${id}/status`,
      `GET /v1/builds/${id}/status`,
      `GET /v1/builds/${id}/status`,
    ]);

    expect(JSON.parse(io.stdout()).build).toMatchObject({
      status: 'uploaded',
      captureStatus: 'not_started',
      sourceVerified: false,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it('requires explicit experimental opt-in', async () => {
  await expect(submitCommand({}, captureIo())).rejects.toThrow(/experimental/);
});

it('requires waiting for GitHub review handoff', async () => {
  await expect(
    submitCommand({ experimental: true, 'review-in-github': true }, captureIo()),
  ).rejects.toThrow(/requires --wait or --resume/);
});
