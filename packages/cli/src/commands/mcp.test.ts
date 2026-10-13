// `jux mcp` over a real process: the built CLI, spawned, spoken to in
// newline-delimited JSON-RPC on stdio, the way an MCP client does it.
// Needs `pnpm build` first (CI builds before testing).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, (r: Rpc) => void>();
  private next = 1;

  constructor(project: string) {
    this.child = spawn(process.execPath, [CLI, 'mcp', '--project', project], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.lines.push(line);
      const msg = JSON.parse(line) as Rpc;
      if (typeof msg.id === 'number') this.waiting.get(msg.id)?.(msg);
    });
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
    const exited = new Promise<number | null>((r) => this.child.once('exit', r));
    this.child.stdin.end();
    return exited;
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

describe.skipIf(!chrome())('jux mcp against a real page', () => {
  let project: string;
  let server: Server;
  let base: string;
  // The page changes between snaps the way an edit would.
  let edited = false;
  beforeAll(async () => {
    project = mkdtempSync(path.join(tmpdir(), 'jux-mcp-page-'));
    server = createServer((_req, res) => {
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
});
