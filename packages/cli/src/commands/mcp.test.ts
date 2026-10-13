// `jux mcp` over a real process: the built CLI, spawned, spoken to in
// newline-delimited JSON-RPC on stdio, the way an MCP client does it.
// Needs `pnpm build` first (CI builds before testing).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cropImages } from './mcp.js';
import { MAX_CROPS, resolveChrome } from '@juxtapose/core';

const CLI = path.resolve(import.meta.dirname, '../../dist/index.js');

function chrome() {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
}

interface Rpc {
  jsonrpc: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
}

class Client {
  readonly lines: string[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  stderr = '';
  private readonly waiting = new Map<number, (r: Rpc) => void>();
  private next = 1;

  constructor(project: string) {
    this.child = spawn(process.execPath, [CLI, 'mcp', '--project', project], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((r) => this.child.once('exit', r));
    this.child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.lines.push(line);
      const msg = JSON.parse(line) as Rpc;
      if (typeof msg.id === 'number') this.waiting.get(msg.id)?.(msg);
    });
  }

  /** The id the next request() will use. */
  peekId(): number {
    return this.next;
  }

  request(method: string, params?: unknown): Promise<Rpc> {
    const id = this.next++;
    const reply = new Promise<Rpc>((resolve) => this.waiting.set(id, resolve));
    this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return reply;
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const r = await this.request('tools/call', { name, arguments: args });
    expect(r.error).toBeUndefined();
    return r.result as unknown as ToolResult;
  }

  send(msg: unknown): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Closing stdin is how a client ends the session; the server must exit. */
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

async function handshake(c: Client): Promise<Rpc> {
  const init = await c.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return init;
}

const text = (r: ToolResult) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** Every stdout line is a JSON-RPC 2.0 message: anything else breaks the client. */
function expectOnlyProtocol(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
}

describe('jux mcp protocol', () => {
  let project: string;
  beforeAll(() => {
    project = mkdtempSync(path.join(tmpdir(), 'jux-mcp-'));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  test('initialize, ping and tools/list answer with the 2025-06-18 shapes', async () => {
    const c = new Client(project);
    const init = await handshake(c);
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'jux' },
    });
    expect((await c.request('ping')).result).toEqual({});
    const list = await c.request('tools/list');
    const tools = (
      list.result as { tools: Array<{ name: string; inputSchema: unknown }> }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'snap',
      'diff',
      'run',
      'check',
      'handoff',
      'approve',
    ]);
    for (const t of tools) expect(t.inputSchema).toMatchObject({ type: 'object' });
    expect((await c.request('nope/nope')).error?.code).toBe(-32601);
    expect((await c.request('tools/call', { name: 'nope' })).error?.code).toBe(-32602);
    expect(await c.close()).toBe(0);
    expectOnlyProtocol(c.lines);
  });

  test('approve rejects missing, empty and unknown ids as tool errors', async () => {
    const c = new Client(project);
    await handshake(c);
    for (const args of [{}, { stories: [] }, { stories: [''] }, { stories: 'all' }]) {
      const r = await c.call('approve', args);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/stories/);
    }
    // No run in this project yet: still an error, never "nothing to approve".
    const r = await c.call('approve', { stories: ['button--primary'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no run found/);
    await c.close();
    expectOnlyProtocol(c.lines);
  });

  test('a usage error from the command is isError with its message', async () => {
    const c = new Client(project);
    await handshake(c);
    const missing = await c.call('diff', { a: 'never', b: 'taken' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/no snap named 'never'/);
    const bad = await c.call('snap', { url: 'http://127.0.0.1:1/' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/needs 'as'/);
    await c.close();
    expectOnlyProtocol(c.lines);
  });
});

describe('jux mcp confinement', () => {
  let root: string;
  let project: string;
  let outside: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'jux-mcp-conf-')));
    project = path.join(root, 'app');
    outside = path.join(root, 'elsewhere');
    mkdirSync(path.join(project, 'packages', 'web'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(project, 'escape'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('project must be the server root or inside it, by real path', async () => {
    const c = new Client(project);
    await handshake(c);
    for (const p of [outside, '../elsewhere', 'escape', '/']) {
      const r = await c.call('diff', { a: 'x', b: 'y', project: p });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/'project' must be the server's project/);
      const s = await c.call('snap', { url: 'http://127.0.0.1:1/', as: 'x', project: p });
      expect(s.isError).toBe(true);
      expect(text(s)).toMatch(/'project' must be/);
    }
    // Inside is fine: the error is now about the missing snap, not the project.
    for (const p of ['packages/web', path.join(project, 'packages'), '.']) {
      const r = await c.call('diff', { a: 'x', b: 'y', project: p });
      expect(text(r)).toMatch(/no snap named 'x'/);
    }
    await c.close();
    expectOnlyProtocol(c.lines);
  });

  test('diff takes snap names only, never paths', async () => {
    const c = new Client(project);
    await handshake(c);
    for (const ref of [
      path.join(outside, 'a.webp'),
      'a.webp',
      '../x',
      'x/y',
      'Before',
      '-x',
    ]) {
      for (const prefix of [false, true]) {
        const r = await c.call('diff', { a: ref, b: 'after', prefix });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/'a' must be a snap name/);
      }
    }
    await c.close();
  });

  test('crop images are read only from inside <project>/.juxtapose/crops', async () => {
    const crops = path.join(project, '.juxtapose', 'crops', 'a~vs~b');
    mkdirSync(crops, { recursive: true });
    const png = Buffer.from('\x89PNG fake');
    writeFileSync(path.join(crops, 'crop-1.png'), png);
    writeFileSync(path.join(outside, 'secret.png'), 'secret');
    symlinkSync(path.join(outside, 'secret.png'), path.join(crops, 'crop-2.png'));
    const result = {
      isError: false,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            schema: 'juxtapose.crops/v1',
            crops: [
              { file: '.juxtapose/crops/a~vs~b/crop-1.png' },
              { file: '.juxtapose/crops/a~vs~b/crop-2.png' },
              { file: '../elsewhere/secret.png' },
              { file: 'escape/secret.png' },
            ],
          }),
        },
      ],
    };
    const images = await cropImages(result, project);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ type: 'image', data: png.toString('base64') });
  });
});

describe('jux mcp lifecycle', () => {
  let project: string;
  beforeAll(() => {
    project = mkdtempSync(path.join(tmpdir(), 'jux-mcp-life-'));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  test('client responses are ignored; a non-string, non-number id is -32600 with id null', async () => {
    const c = new Client(project);
    await handshake(c);
    const before = c.lines.length;
    c.send({ jsonrpc: '2.0', id: 99, result: {} });
    c.send({ jsonrpc: '2.0', id: 98, error: { code: 1, message: 'x' } });
    for (const id of [null, { x: 1 }, true])
      c.send({ jsonrpc: '2.0', id, method: 'ping' });
    await c.request('ping');
    const replies = c.lines.slice(before).map((l) => JSON.parse(l) as Rpc);
    const invalid = replies.filter((r) => r.error?.code === -32600);
    expect(invalid).toHaveLength(3);
    for (const r of invalid) expect(r.id).toBeNull();
    // Nothing answered the two responses: only the 3 errors and the ping.
    expect(replies).toHaveLength(4);
    await c.close();
  });

  test('SIGTERM exits promptly with 143, SIGINT with 130', async () => {
    for (const [sig, code] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ] as const) {
      const c = new Client(project);
      await handshake(c);
      const t0 = Date.now();
      c.child.kill(sig);
      expect(await c.exited).toBe(code);
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  });

  test('a client that closes stdout (EPIPE) gets an orderly exit, not a crash', async () => {
    const c = new Client(project);
    await handshake(c);
    c.child.stdout.destroy();
    for (let i = 0; i < 20; i++) c.send({ jsonrpc: '2.0', id: 1000 + i, method: 'ping' });
    expect(await c.exited).toBe(3);
    expect(c.stderr).not.toMatch(/EPIPE|Unhandled|unexpected failure/);
  });

  test('viewport outside 1..10000 is a usage error', async () => {
    const c = new Client(project);
    await handshake(c);
    const r = await c.call('snap', {
      url: 'http://127.0.0.1:1/',
      as: 'x',
      viewport: { width: 10001, height: 100 },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/each 1 to 10000/);
    await c.close();
  });
});

describe.skipIf(!chrome())('jux mcp against a real page', () => {
  let project: string;
  let server: Server;
  let base: string;
  // The page changes between snaps the way an edit would.
  let edited = false;
  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), 'jux-mcp-page-'));
    server = createServer((req, res) => {
      // Never answers: a call stuck on it is one to cancel or interrupt.
      if (req.url?.startsWith('/slow')) return;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><body style="margin:0;font:16px sans-serif">
<h1>Settings</h1>
<button style="background:${edited ? '#c00' : '#06c'};color:#fff;padding:8px 16px;border:0">${edited ? 'Save changes' : 'Save'}</button>
</body>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('snap, snap, diff returns a verdict with the real change, and crops as images', async () => {
    const c = new Client(project);
    await handshake(c);
    const viewport = { width: 400, height: 200 };

    const before = await c.call('snap', { url: base, as: 'before', viewport });
    expect(before.isError).toBe(false);
    expect(JSON.parse(text(before))).toMatchObject({ name: 'before', viewport });

    edited = true;
    const after = await c.call('snap', { url: base, as: 'after', viewport });
    expect(after.isError).toBe(false);

    // Differences are an answer (CLI exit 1), not an error.
    const diff = await c.call('diff', { a: 'before', b: 'after' });
    expect(diff.isError).toBe(false);
    expect(diff.content).toHaveLength(1);
    const verdict = JSON.parse(text(diff)) as {
      schema: string;
      classification: string;
      deltaCount: number;
      summary: string;
    };
    expect(verdict.schema).toBe('juxtapose.verdict/v1');
    expect(verdict.classification).not.toBe('identical');
    expect(verdict.deltaCount).toBeGreaterThan(0);
    expect(verdict.summary).toMatch(/Save/);

    const same = await c.call('diff', { a: 'after', b: 'after' });
    expect(JSON.parse(text(same))).toMatchObject({ classification: 'identical' });

    const crops = await c.call('diff', { a: 'before', b: 'after', crops: true });
    expect(crops.isError).toBe(false);
    const parsed = JSON.parse(crops.content[0].text!) as {
      schema: string;
      crops: unknown[];
    };
    expect(parsed.schema).toBe('juxtapose.crops/v1');
    const images = crops.content.filter((b) => b.type === 'image');
    expect(images.length).toBe(parsed.crops.length);
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBeLessThanOrEqual(MAX_CROPS);
    expect(images[0].mimeType).toBe('image/png');
    // PNG magic number, so the block is the file and not a path.
    expect(Buffer.from(images[0].data!, 'base64').subarray(1, 4).toString()).toBe('PNG');

    expect(await c.close()).toBe(0);
    expectOnlyProtocol(c.lines);
  }, 60_000);

  test('notifications/cancelled: a queued call never runs, a running one is not answered and frees the queue', async () => {
    const c = new Client(project);
    await handshake(c);
    const slowId = c.peekId();
    void c.request('tools/call', {
      name: 'snap',
      arguments: { url: `${base}slow`, as: 'slow' },
    });
    const queuedId = c.peekId();
    void c.request('tools/call', {
      name: 'diff',
      arguments: { a: 'before', b: 'never' },
    });
    c.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: queuedId },
    });
    c.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: slowId },
    });
    // Answered quickly although the slow snap is still loading.
    const t0 = Date.now();
    // Any answer will do (this pair does not exist): it proves the queue moved.
    const next = await c.call('diff', { a: 'nope', b: 'nope-too' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(text(next)).toMatch(/no snap named 'nope'/);
    const ids = c.lines.map((l) => (JSON.parse(l) as Rpc).id);
    expect(ids).not.toContain(slowId);
    expect(ids).not.toContain(queuedId);
    c.child.kill('SIGTERM');
    expect(await c.exited).toBe(143);
  }, 30_000);

  test('SIGTERM during a capture exits promptly without answering it', async () => {
    const c = new Client(project);
    await handshake(c);
    // Warm the browser so the signal lands mid-capture, not mid-launch.
    await c.call('snap', { url: base, as: 'warm' });
    const slowId = c.peekId();
    void c.request('tools/call', {
      name: 'snap',
      arguments: { url: `${base}slow`, as: 'slow' },
    });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    c.child.kill('SIGTERM');
    expect(await c.exited).toBe(143);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.lines.map((l) => (JSON.parse(l) as Rpc).id)).not.toContain(slowId);
  }, 30_000);
});
