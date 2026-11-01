import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { submitCommand } from './submit.js';
import { captureIo } from '../io.js';
const id = '10000000-0000-4000-8000-000000000001';
const preview = {
  schema: 'juxtapose.preview-status/v1',
  buildId: id,
  sourceSha: 'a'.repeat(40),
  branch: 'main',
  state: 'ready',
  terminal: true,
  reason: null,
  retryAfterMs: 2000,
  url: `https://app.juxtapose.dev/acme/app/preview/build/${id}`,
};
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it('prints a viewable preview without a visual verdict and removes signal handlers', async () => {
  vi.stubEnv('JUXTAPOSE_TOKEN', 'preview-token');
  vi.stubEnv('JUXTAPOSE_API_URL', 'https://api.juxtapose.dev');
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(preview), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const before = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
  const io = captureIo();
  expect(
    await submitCommand(
      { experimental: true, resume: id, 'wait-preview': true, json: true },
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(io.stdout())).toEqual({ buildId: id, preview });
  expect(io.stdout()).not.toMatch(/preview-token|verdict|captureStatus/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal))).toEqual(
    before,
  );
});
it.each([
  { state: 'ready', reason: 'viewer_disabled' },
  { state: 'disabled', reason: 'preview_disabled' },
  { state: 'failed', reason: 'preview_failed' },
  { state: 'expired', reason: 'preview_expired' },
  { state: 'not_requested', reason: 'preview_not_requested' },
])(
  'returns nonzero for terminal unavailable preview %j without capture fallback',
  async (patch) => {
    vi.stubEnv('JUXTAPOSE_TOKEN', 'preview-token');
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...preview, ...patch, url: null }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const io = captureIo();
    expect(
      await submitCommand({ experimental: true, resume: id, 'wait-preview': true }, io),
    ).toBe(3);
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain(patch.reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('keeps ordinary upload free of status reads, waits upload-only, and resumes through the built CLI with GET only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-preview-submit-'));
  dirs.push(root);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  await writeFile(path.join(root, 'source.txt'), 'source');
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
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const build = path.join(root, 'storybook-static');
  await mkdir(build);
  for (const name of ['index.html', 'iframe.html', 'index.json'])
    await writeFile(
      path.join(build, name),
      name.endsWith('.json') ? '{}' : '<h1>Story</h1>',
    );
  const calls: string[] = [];
  let metadata: Record<string, unknown> = {};
  let lastArchiveBytes = 0;
  const server = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    expect(req.headers.authorization).toBe('Bearer preview-token');
    res.setHeader('content-type', 'application/json');
    if (req.url === `/v1/builds/${id}/preview` && req.method === 'GET') {
      res.end(
        JSON.stringify({
          ...preview,
          sourceSha,
          state: 'disabled',
          reason: 'preview_disabled',
          url: null,
        }),
      );
      return;
    }
    if (req.url === '/v1/builds' && req.method === 'POST')
      metadata = JSON.parse(Buffer.concat(chunks).toString());
    else if (req.url === `/v1/builds/${id}/archive` && req.method === 'PUT')
      lastArchiveBytes = Buffer.concat(chunks).length;
    else {
      res.statusCode = 500;
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        build: {
          id,
          status: req.method === 'POST' ? 'awaiting_upload' : 'uploaded',
          ...metadata,
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
  if (!address || typeof address === 'string') throw new Error('address');
  vi.stubEnv('JUXTAPOSE_API_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('JUXTAPOSE_TOKEN', 'preview-token');
  vi.stubEnv('GITHUB_REF', 'refs/heads/main');
  try {
    const flags = { experimental: true, project: root, 'build-dir': build };
    const ordinary = captureIo();
    expect(await submitCommand(flags, ordinary)).toBe(0);
    expect(ordinary.stdout()).toContain('If preview publication is enabled');
    expect(calls.splice(0)).toEqual(['POST /v1/builds', `PUT /v1/builds/${id}/archive`]);
    expect(lastArchiveBytes).toBeGreaterThan(0);
    const waited = captureIo();
    expect(await submitCommand({ ...flags, 'wait-preview': true }, waited)).toBe(3);
    expect(waited.stderr()).toContain('preview_disabled');
    expect(calls.splice(0)).toEqual([
      'POST /v1/builds',
      `PUT /v1/builds/${id}/archive`,
      `GET /v1/builds/${id}/preview`,
    ]);
    const empty = path.join(root, 'empty');
    await mkdir(empty);
    const child = spawn(
      process.execPath,
      [
        path.resolve('packages/cli/dist/index.js'),
        'submit',
        '--experimental',
        '--resume',
        id,
        '--wait-preview',
        '--json',
      ],
      {
        cwd: empty,
        timeout: 5000,
        env: {
          ...process.env,
          JUXTAPOSE_API_URL: `http://127.0.0.1:${address.port}`,
          JUXTAPOSE_TOKEN: 'preview-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (s: Buffer) => {
      stdout += s.toString();
    });
    child.stderr.on('data', (s: Buffer) => {
      stderr += s.toString();
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(exit, stderr).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({
      buildId: id,
      preview: { state: 'disabled', url: null },
    });
    expect(stderr).toContain('preview_disabled');
    expect(stdout + stderr).not.toContain('preview-token');
    expect(calls).toEqual([`GET /v1/builds/${id}/preview`]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
