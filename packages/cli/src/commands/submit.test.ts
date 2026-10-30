import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  const id = '019a0000-0000-7000-8000-000000000001';
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
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
    expect(createHash('sha256').update(uploaded!).digest('hex')).toBe(
      requests[0]!.archiveSha256,
    );
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
