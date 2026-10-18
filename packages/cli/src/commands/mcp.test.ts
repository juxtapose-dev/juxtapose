// `jux mcp` over a real process: the built CLI, spawned, spoken to in
// newline-delimited JSON-RPC on stdio, the way an MCP client does it.
// Needs `pnpm build` first (CI builds before testing).

import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
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

  constructor(project: string, extraArgs: string[] = []) {
    this.child = spawn(
      process.execPath,
      [CLI, 'mcp', '--project', project, ...extraArgs],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
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

  /** Several requests in one write, so the server reads them in one chunk. */
  requestMany(calls: Array<{ name: string; arguments: unknown }>): Array<Promise<Rpc>> {
    const replies: Array<Promise<Rpc>> = [];
    const lines: string[] = [];
    for (const c of calls) {
      const id = this.next++;
      replies.push(new Promise<Rpc>((resolve) => this.waiting.set(id, resolve)));
      lines.push(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: c }));
    }
    this.child.stdin.write(lines.join('\n') + '\n');
    return replies;
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
      'list',
      'run',
      'report',
      'check',
      'handoff',
      'reference',
      'explain',
      'approve',
    ]);
    for (const t of tools) expect(t.inputSchema).toMatchObject({ type: 'object' });
    for (const name of ['run', 'explain'])
      expect(
        (
          tools.find((t) => t.name === name)!.inputSchema as {
            properties: Record<string, unknown>;
          }
        ).properties['recheck'],
      ).toMatchObject({ type: 'string', enum: ['changed', 'new', 'off'] });
    // The config's shapes, as plain enums an agent reads at a glance.
    const snap = tools[0]!.inputSchema as {
      properties: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(snap.properties['network']!.properties['external']).toMatchObject({
      anyOf: [
        { type: 'string', enum: ['allow', 'block'] },
        {
          type: 'object',
          properties: { images: { enum: ['allow', 'block', 'placeholder'] } },
        },
      ],
    });
    expect(snap.properties['network']!.properties['rules']).toMatchObject({
      type: 'array',
      items: { properties: { action: { enum: ['allow', 'block', 'placeholder'] } } },
    });
    expect((await c.request('nope/nope')).error?.code).toBe(-32601);
    expect((await c.request('tools/call', { name: 'nope' })).error?.code).toBe(-32602);
    expect(await c.close()).toBe(0);
    expectOnlyProtocol(c.lines);
  });

  test('list and run dryRun share selectors without capturing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jux-mcp-list-'));
    writeFileSync(
      path.join(root, 'juxtapose.config.json'),
      JSON.stringify({
        platform: 'urls',
        urls: [
          { id: 'charts-a', url: 'http://127.0.0.1:1/' },
          { id: 'table-a', url: 'http://127.0.0.1:1/' },
        ],
      }),
    );
    const c = new Client(root);
    try {
      await handshake(c);
      for (const name of ['list', 'run']) {
        const result = await c.call(name, {
          stories: ['charts-*'],
          ...(name === 'run' ? { dryRun: true } : {}),
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(text(result))).toMatchObject({
          schema: 'juxtapose.selection/v1',
          count: 1,
          captures: [{ storyId: 'charts-a' }],
        });
      }
      expect(existsSync(path.join(root, '.juxtapose', 'runs'))).toBe(false);
    } finally {
      await c.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('explain returns juxtapose.explain/v1 with the call layer on top, and refuses bad input', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jux-mcp-explain-'));
    writeFileSync(
      path.join(root, 'juxtapose.config.json'),
      JSON.stringify({
        platform: 'urls',
        settle: { timeout: 3000 },
        urls: [
          {
            id: 'home',
            url: 'http://127.0.0.1:1/',
            variants: { dark: { colorScheme: 'dark' } },
          },
        ],
      }),
    );
    try {
      const c = new Client(root);
      await handshake(c);
      const ok = await c.call('explain', { story: 'home' });
      expect(ok.isError).not.toBe(true);
      const e = JSON.parse(text(ok));
      expect(e).toMatchObject({
        schema: 'juxtapose.explain/v1',
        storyId: 'home',
        variants: ['home__dark'],
      });
      expect(e.settings).toContainEqual({
        setting: 'settle.timeout',
        value: 3000,
        source: [{ layer: 'project' }],
      });
      const over = JSON.parse(
        text(await c.call('explain', { story: 'home__dark', settle: { timeout: 9000 } })),
      );
      expect(over.settings).toContainEqual({
        setting: 'settle.timeout',
        value: 9000,
        source: [{ layer: 'mcp' }],
      });
      const mode = (r: Awaited<ReturnType<typeof c.call>>) =>
        JSON.parse(text(r)).settings.find(
          (x: { setting: string }) => x.setting === 'recheck',
        );
      expect(mode(ok)).toEqual({
        setting: 'recheck',
        value: 'changed',
        source: [{ layer: 'default' }],
      });
      expect(mode(await c.call('explain', { story: 'home', recheck: 'off' }))).toEqual({
        setting: 'recheck',
        value: 'off',
        source: [{ layer: 'mcp' }],
      });
      const unknown = await c.call('explain', { story: 'hom' });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toMatch(/Did you mean 'home'/);
      for (const args of [{}, { story: '' }]) {
        const bad = await c.call('explain', args);
        expect(bad.isError).toBe(true);
        expect(text(bad)).toMatch(/story/);
      }
      await c.close();
      expectOnlyProtocol(c.lines);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    // A bad settle argument names the argument and the field, before any capture.
    const settle = await c.call('snap', {
      url: 'http://127.0.0.1:1/',
      as: 'x',
      settle: { timeout: 0 },
    });
    expect(settle.isError).toBe(true);
    expect(text(settle)).toMatch(/'settle': settle.timeout must be a whole number of ms/);
    // `recheck` is checked before any capture, on both tools that take it.
    for (const tool of ['run', 'explain']) {
      const mode = await c.call(tool, { story: 'x', recheck: 'sometimes' });
      expect(mode.isError).toBe(true);
      expect(text(mode)).toMatch(/'recheck' must be changed, new, off/);
    }
    const pattern = await c.call('run', {
      settle: { network: { ignore: ['type:Nope'] } },
    });
    expect(pattern.isError).toBe(true);
    expect(text(pattern)).toMatch(/unknown resource type 'Nope'/);
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
    // jux's own .juxtapose directory is not a project, at any depth.
    mkdirSync(path.join(project, '.juxtapose', 'snaps'), { recursive: true });
    mkdirSync(path.join(project, 'packages', 'web', '.juxtapose'), { recursive: true });
    for (const p of ['.juxtapose', '.juxtapose/snaps', 'packages/web/.juxtapose']) {
      const r = await c.call('diff', { a: 'x', b: 'y', project: p });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not be inside a \.juxtapose directory/);
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
      'x\\y',
      'a\u0000b',
      '..',
      'X.WEBP',
      '',
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
    // A urls project, so check gets past workbench detection to "no run".
    writeFileSync(
      path.join(project, 'juxtapose.config.json'),
      JSON.stringify({
        platform: 'urls',
        urls: [{ id: 'x', url: 'http://127.0.0.1:1/' }],
      }),
    );
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

  test('a request id already in flight is refused with -32600; the first call still answers', async () => {
    const c = new Client(project);
    await handshake(c);
    const call = (n: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'dup',
        method: 'tools/call',
        params: { name: 'diff', arguments: { a: `x${n}`, b: 'y' } },
      });
    c.child.stdin.write(`${call(1)}\n${call(2)}\n`);
    await new Promise((r) => setTimeout(r, 1000));
    const replies = c.lines
      .map((l) => JSON.parse(l) as Rpc)
      .filter((m) => m.id === 'dup');
    expect(replies).toHaveLength(2);
    expect(replies.find((m) => m.error)?.error?.code).toBe(-32600);
    const ok = replies.find((m) => m.result)?.result as unknown as ToolResult;
    expect(text(ok)).toMatch(/no snap named 'x1'/);
    expect(await c.close()).toBe(0);
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
    expect(text(r)).toMatch(/'viewport' width and height must each be 1 to 10000\./);
    const zero = await c.call('snap', {
      url: 'http://127.0.0.1:1/',
      as: 'x',
      viewport: { width: 0, height: 100 },
    });
    expect(zero.isError).toBe(true);
    expect(text(zero)).toMatch(/'viewport' width and height must each be 1 to 10000/);
    await c.close();
  });

  test('an unknown device or orientation is a usage error', async () => {
    const c = new Client(project);
    await handshake(c);
    const r = await c.call('snap', {
      url: 'http://127.0.0.1:1/',
      as: 'x',
      device: 'iphone15',
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('did you mean iphone-15');
    const bad = await c.call('snap', {
      url: 'http://127.0.0.1:1/',
      as: 'x',
      orientation: 'sideways',
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/orientation/);
    await c.close();
  });

  test('error text names tools, not shell commands', async () => {
    const c = new Client(project);
    await handshake(c);
    const check = await c.call('check', {});
    expect(check.isError).toBe(true);
    expect(text(check)).toMatch(/Call the run tool first\./);
    const crops = await c.call('diff', { a: 'x', b: 'y', prefix: true, crops: true });
    expect(crops.isError).toBe(true);
    expect(text(crops)).toMatch(
      /Call diff with prefix first, then diff with a single pair and crops: true\./,
    );
    for (const r of [check, crops]) expect(text(r)).not.toMatch(/`jux /);
    await c.close();
  });
});

describe.skipIf(!chrome())('jux mcp against a real page', () => {
  let project: string;
  let server: Server;
  let base: string;
  // The page changes between snaps the way an edit would.
  let edited = false;
  let lateSentAt = 0;
  const pageHits: Array<{ path: string; at: number }> = [];
  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), 'jux-mcp-page-'));
    server = createServer((req, res) => {
      // Never answers: a call stuck on it is one to cancel or interrupt.
      if (req.url?.startsWith('/slow')) return;
      // Holds the renderer's main thread from DOMContentLoaded on (#163).
      if (req.url?.startsWith('/busy')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          `<!doctype html><body><script>addEventListener('DOMContentLoaded',()=>{const t=Date.now();while(Date.now()-t<90000);})</script>busy</body>`,
        );
        return;
      }
      // Answers after a delay, and records when: a call blocked on it settles
      // no earlier than that.
      if (req.url?.startsWith('/late')) {
        setTimeout(() => {
          lateSentAt = Date.now();
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><p>late</p>');
        }, 1500);
        return;
      }
      // Four distinct pages for the parallel-vs-serial determinism check:
      // text, rounded corners, a gradient and a shadow, the antialiased edges
      // where a shared or contended renderer would first show.
      const page = /^\/p\/(\d)$/.exec(req.url ?? '');
      if (page) {
        pageHits.push({ path: req.url!, at: Date.now() });
        const n = Number(page[1]);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          `<!doctype html><body style="margin:0;padding:16px;font:15px sans-serif">
<h2 style="margin:0 0 8px">Page ${n}</h2>
<div style="width:${120 + n * 20}px;height:60px;border-radius:${6 * n}px;background:linear-gradient(${n * 40}deg,#36c,#c63);box-shadow:0 2px ${n * 3}px rgba(0,0,0,.4)"></div>
<p style="transform:rotate(${n}deg)">${'Lorem ipsum dolor sit amet. '.repeat(n * 3)}</p>
<input value="field ${n}"> <button>Go ${n}</button>
</body>`,
        );
        return;
      }
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

    const phone = await c.call('snap', { url: base, as: 'phone', device: 'pixel-8' });
    expect(phone.isError).toBe(false);
    expect(JSON.parse(text(phone))).toMatchObject({
      device: 'pixel-8',
      viewport: { width: 412, height: 915 },
    });

    const short = await c.call('snap', {
      url: base,
      as: 'short',
      device: 'pixel-8',
      viewport: { width: 412, height: 600 },
    });
    expect(short.isError).toBe(false);
    expect(JSON.parse(text(short))).toMatchObject({
      device: 'pixel-8',
      viewport: { width: 412, height: 600 },
    });

    const wide = await c.call('snap', {
      url: base,
      as: 'wide',
      orientation: 'landscape',
      viewport,
    });
    expect(JSON.parse(text(wide))).toMatchObject({ viewport });

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

    // Names normalize as snap's `as` does: "BEFORE" is the snap `before`.
    const upper = await c.call('diff', { a: 'BEFORE', b: 'After' });
    expect(upper.isError).toBe(false);
    // Same verdict; only escalate.command echoes the names as typed.
    const { escalate: _e1, ...upperRest } = JSON.parse(text(upper)) as Record<
      string,
      unknown
    >;
    const { escalate: _e2, ...rest } = verdict as unknown as Record<string, unknown>;
    expect(upperRest).toEqual(rest);

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

  test('notifications/cancelled: a queued call never runs; a running one is not answered and holds its locks until it settles', async () => {
    const c = new Client(project);
    await handshake(c);
    await c.call('snap', { url: base, as: 'warm' });
    const lateId = c.peekId();
    void c.request('tools/call', {
      name: 'snap',
      arguments: { url: `${base}late`, as: 'late' },
    });
    // Reads `late`, so it queues behind the snap writing it.
    const queuedId = c.peekId();
    void c.request('tools/call', { name: 'diff', arguments: { a: 'late', b: 'warm' } });
    await new Promise((r) => setTimeout(r, 200));
    c.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: queuedId },
    });
    c.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: lateId },
    });
    // Reads `late` too: it must not start until the cancelled snap's page has
    // answered and the capture settled.
    const next = await c.call('diff', { a: 'nope', b: 'late' });
    const answeredAt = Date.now();
    expect(text(next)).toMatch(/no snap named 'nope'/);
    expect(lateSentAt).toBeGreaterThan(0);
    expect(answeredAt).toBeGreaterThanOrEqual(lateSentAt);
    const ids = c.lines.map((l) => (JSON.parse(l) as Rpc).id);
    expect(ids).not.toContain(lateId);
    expect(ids).not.toContain(queuedId);
    // The cancelled snap ran to completion before the next call on its name.
    expect(existsSync(path.join(project, '.juxtapose', 'snaps', 'late.webp'))).toBe(true);
    expect(await c.close()).toBe(0);
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

  test('a hung URL errors once within storyTimeout; later URLs capture and other calls are not stalled (#163)', async () => {
    const budgeted = mkdtempSync(path.join(tmpdir(), 'jux-mcp-budget-'));
    writeFileSync(
      path.join(budgeted, 'juxtapose.config.json'),
      JSON.stringify({ storyTimeout: 3000 }),
    );
    const c = new Client(budgeted);
    await handshake(c);
    try {
      const viewport = { width: 400, height: 200 };
      await c.call('snap', { url: base, as: 'warm', viewport });
      const t0 = Date.now();
      const hung = c.call('snap', {
        urls: [`${base}busy`, `${base}p/1`, `${base}p/2`],
        asPrefix: 'hung',
        viewport,
      });
      // A different name: it needs no lock the hung call holds.
      await new Promise((r) => setTimeout(r, 500));
      const other = await c.call('snap', { url: `${base}p/3`, as: 'other', viewport });
      const otherMs = Date.now() - t0;
      expect(other.isError).toBe(false);
      expect(otherMs).toBeLessThan(3000);
      const r = await hung;
      expect(Date.now() - t0).toBeLessThan(3000 + 5000 + 8000);
      expect(r.isError).toBe(true);
      const json = text(r)
        .split('\n')
        .find((l) => l.startsWith('{'));
      const { snaps } = JSON.parse(json!) as {
        snaps: Array<{ url: string; error?: string; name?: string }>;
      };
      expect(snaps).toHaveLength(3);
      expect(snaps[0]!.error).toMatch(/exceeded its 3000 ms budget while in '/);
      expect(snaps.slice(1).map((x) => x.error)).toEqual([undefined, undefined]);
      expect(snaps.slice(1).map((x) => x.name)).toEqual(['hung-p-1', 'hung-p-2']);
    } finally {
      await c.close();
      rmSync(budgeted, { recursive: true, force: true });
    }
  }, 60_000);

  test('a crashed private browser is closed (profile removed) and replaced', async () => {
    const c = new Client(project);
    await handshake(c);
    await c.call('snap', { url: base, as: 'crash-1' });
    const chromePid = () =>
      execFileSync('pgrep', ['-P', String(c.child.pid)], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number);
    const [pid] = chromePid();
    expect(pid).toBeGreaterThan(0);
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const profile = /--user-data-dir=(\S+)/.exec(args)?.[1];
    expect(profile && existsSync(profile)).toBe(true);
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    // Two snaps find the dead browser at once: they must share one
    // replacement, not launch one each and leak all but the last.
    const again = await Promise.all([
      c.call('snap', { url: base, as: 'crash-2' }),
      c.call('snap', { url: base, as: 'crash-3' }),
    ]);
    expect(again.map((r) => r.isError)).toEqual([false, false]);
    expect(existsSync(profile!)).toBe(false);
    expect(chromePid()).not.toContain(pid);
    expect(chromePid()).toHaveLength(1);
    expect(await c.close()).toBe(0);
  }, 30_000);

  test('4 snaps in parallel are byte-identical to the same 4 taken one at a time', async () => {
    // The default pool is half the cores (2 on a 4-core CI runner), which
    // cannot overlap 4 snaps; ask for 4 so the overlap assertion means something.
    const c = new Client(project, ['--concurrency', '4']);
    await handshake(c);
    const pages = [1, 2, 3, 4].map((n) => `${base}p/${n}`);
    const viewport = { width: 480, height: 320 };
    // Warm the browser first, so neither pass pays the launch.
    await c.call('snap', { url: base, as: 'warm', viewport });

    pageHits.length = 0;
    const sent = Date.now();
    const replies: number[] = [];
    const par = await Promise.all(
      pages.map((url, i) =>
        c.call('snap', { url, as: `par-${i + 1}`, viewport }).then((r) => {
          replies.push(Date.now());
          return r;
        }),
      ),
    );
    expect(par.map((r) => r.isError)).toEqual([false, false, false, false]);
    // They really overlapped: every page was requested before any snap answered.
    expect(pageHits).toHaveLength(4);
    expect(Math.max(...pageHits.map((h) => h.at))).toBeLessThan(Math.min(...replies));
    expect(Math.min(...pageHits.map((h) => h.at))).toBeGreaterThanOrEqual(sent);

    for (const [i, url] of pages.entries()) {
      const r = await c.call('snap', { url, as: `ser-${i + 1}`, viewport });
      expect(r.isError).toBe(false);
    }
    expect(await c.close()).toBe(0);

    const snaps = path.join(project, '.juxtapose', 'snaps');
    const sha = (f: string) =>
      createHash('sha256')
        .update(readFileSync(path.join(snaps, f)))
        .digest('hex');
    const structure = (f: string) =>
      gunzipSync(readFileSync(path.join(snaps, f))).toString('utf8');
    const hashes = new Set<string>();
    for (const n of [1, 2, 3, 4]) {
      expect(sha(`par-${n}.webp`), `page ${n} pixels`).toBe(sha(`ser-${n}.webp`));
      expect(structure(`par-${n}.structure.json.gz`), `page ${n} structure`).toBe(
        structure(`ser-${n}.structure.json.gz`),
      );
      hashes.add(sha(`ser-${n}.webp`));
    }
    // Four different pages, so a mix-up between parallel calls cannot hide.
    expect(hashes.size).toBe(4);
  }, 60_000);

  test('conflicting calls start in arrival order: a diff sent before a snap of its name reads the old snap', async () => {
    const c = new Client(project);
    await handshake(c);
    const viewport = { width: 400, height: 240 };
    expect(
      (await c.call('snap', { url: `${base}p/1`, as: 'ord-ref', viewport })).isError,
    ).toBe(false);
    for (let round = 0; round < 5; round++) {
      expect(
        (await c.call('snap', { url: `${base}p/1`, as: 'ord', viewport })).isError,
      ).toBe(false);
      // One write: the server reads both before either is planned. The diff
      // resolves its project and imports diff.js; the snap must still wait.
      const [diff, snap] = c.requestMany([
        { name: 'diff', arguments: { a: 'ord-ref', b: 'ord' } },
        { name: 'snap', arguments: { url: `${base}p/2`, as: 'ord', viewport } },
      ]);
      const d = (await diff).result as unknown as ToolResult;
      expect(JSON.parse(text(d)), `round ${round}`).toMatchObject({
        classification: 'identical',
      });
      expect(((await snap).result as unknown as ToolResult).isError).toBe(false);
    }
    // And the snap did land: the same diff now sees page 2.
    const after = await c.call('diff', { a: 'ord-ref', b: 'ord' });
    expect(JSON.parse(text(after))).not.toMatchObject({ classification: 'identical' });
    expect(await c.close()).toBe(0);
  }, 60_000);

  test('run, approve and a cancelled run that leaves the last run in place', async () => {
    const runProject = mkdtempSync(path.join(tmpdir(), 'jux-mcp-run-'));
    const config = (urls: Array<{ id: string; url: string }>) =>
      writeFileSync(
        path.join(runProject, 'juxtapose.config.json'),
        JSON.stringify({ platform: 'urls', urls }),
      );
    const pages = [
      { id: 'home', url: base },
      { id: 'other', url: `${base}?other` },
    ];
    config(pages);
    const c = new Client(runProject);
    try {
      await handshake(c);
      const first = await c.call('run', { all: true });
      expect(first.isError).toBe(false);
      const report = JSON.parse(text(first)) as {
        runId: string;
        schema: string;
        summary: { new: number };
      };
      expect(report.schema).toBe('juxtapose.agent-run/v1');
      expect(report.summary.new).toBe(2);
      const saved = await c.call('report', { runId: report.runId, story: 'home' });
      expect(JSON.parse(text(saved))).toMatchObject({ storyId: 'home', status: 'new' });

      // Every requested id is reported, as JSON; unknown ids are refused.
      const approved = await c.call('approve', { stories: ['home'] });
      expect(approved.isError).toBe(false);
      expect(JSON.parse(text(approved))).toEqual({ approved: ['home'], failed: [] });
      const unknown = await c.call('approve', { stories: ['home', 'nope'] });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toMatch(/not in the last run: nope/);

      // Cancel a run mid-capture: no report, so check still reads the first run.
      config([...pages, { id: 'late', url: `${base}late` }]);
      const runId = c.peekId();
      void c.request('tools/call', { name: 'run', arguments: { all: true } });
      await new Promise((r) => setTimeout(r, 300));
      c.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: runId },
      });
      const check = await c.call('check', {});
      expect(JSON.parse(text(check))).toMatchObject({ runId: report.runId });
      expect(c.lines.map((l) => (JSON.parse(l) as Rpc).id)).not.toContain(runId);
      expect(await c.close()).toBe(0);
    } finally {
      rmSync(runProject, { recursive: true, force: true });
    }
  }, 60_000);

  test('run and approve with a base id cover the story and all its variants', async () => {
    const runProject = mkdtempSync(path.join(tmpdir(), 'jux-mcp-variants-'));
    writeFileSync(
      path.join(runProject, 'juxtapose.config.json'),
      JSON.stringify({
        platform: 'urls',
        urls: [
          { id: 'home', url: base },
          { id: 'other', url: `${base}?other` },
        ],
        variants: {
          dark: { colorScheme: 'dark' },
          mobile: { viewport: { width: 375, height: 812 } },
        },
      }),
    );
    const c = new Client(runProject);
    try {
      await handshake(c);
      const run = await c.call('run', { stories: ['home'], report: 'full' });
      expect(run.isError).toBe(false);
      const report = JSON.parse(text(run)) as {
        results: Array<{ storyId: string; baseStoryId?: string; variant?: string }>;
      };
      expect(report.results.map((r) => [r.storyId, r.baseStoryId, r.variant])).toEqual([
        ['home', undefined, undefined],
        ['home__dark', 'home', 'dark'],
        ['home__mobile', 'home', 'mobile'],
      ]);

      const approved = await c.call('approve', { stories: ['home'] });
      expect(approved.isError).toBe(false);
      expect(JSON.parse(text(approved))).toEqual({
        approved: ['home', 'home__dark', 'home__mobile'],
        failed: [],
      });

      const unknown = await c.call('run', { stories: ['home__nope'] });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toMatch(/home__nope/);
      expect(await c.close()).toBe(0);
    } finally {
      rmSync(runProject, { recursive: true, force: true });
    }
  }, 60_000);
});
