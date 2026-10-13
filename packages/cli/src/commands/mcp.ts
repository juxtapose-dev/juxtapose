// `jux mcp` — a Model Context Protocol server on stdio, for coding agents that
// have no shell or that pay a browser launch per `jux` call.
//
// A skin over the commands, not a second API: every tool calls the same
// function `jux <command> --json` calls, with output captured instead of
// printed, so a tool result is the CLI's own versioned JSON (decision 6 of the
// 2026-10-12 agent toolchain spec). What MCP adds is the session: one browser
// acquired on first use and lent to every snap and run until stdin closes,
// which is the per-call launch cost an agent loop otherwise pays each turn.
//
// Hand-rolled JSON-RPC 2.0 over newline-delimited stdio (MCP 2025-06-18),
// like the dependency-free CDP driver: the surface is five methods.

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { acquireBrowser, MAX_CROPS, type Browser } from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
import { captureIo, type Session } from '../io.js';
import { latestRunDir } from '../run-dir.js';

export const PROTOCOL_VERSION = '2025-06-18';

export interface McpFlags {
  project?: string;
  chrome?: string;
  'no-daemon'?: boolean;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Args = Record<string, unknown>;

type Content =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };

export interface ToolResult {
  content: Content[];
  isError: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Descriptions are sent on every agent turn, so each is the shortest text that
// says when to call the tool and what comes back.
const PROJECT = {
  type: 'string',
  description: 'Project dir (default: the server --project)',
};

export const TOOLS: Tool[] = [
  {
    name: 'snap',
    description:
      'Capture pages (pixels + structure) under a name. Snap before an edit and again after it, then call diff. Pass url+as for one page, or urls+asPrefix for several. Returns the `jux snap --json` result.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL of one page' },
        as: { type: 'string', description: 'Snap name for url, e.g. "before"' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Several URLs' },
        asPrefix: {
          type: 'string',
          description: 'Name prefix for urls; snaps are <prefix>-<path slug>',
        },
        viewport: {
          type: 'object',
          properties: { width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['width', 'height'],
        },
        waitFor: { type: 'string', description: 'CSS selector to wait for' },
        mask: {
          type: 'array',
          items: { type: 'string' },
          description: 'CSS selectors to blank (clocks, random data)',
        },
        project: PROJECT,
      },
    },
  },
  {
    name: 'diff',
    description:
      'Compare two snaps. Returns juxtapose.verdict/v1 (prefix: juxtapose.verdict-set/v1); differences are a result, not an error. Set crops only when the verdict\'s `explained` is not "full": it adds juxtapose.crops/v1 and baseline|current PNG strips.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'Earlier snap name (or prefix)' },
        b: { type: 'string', description: 'Later snap name (or prefix)' },
        prefix: { type: 'boolean', description: 'a and b are snap asPrefix values' },
        crops: { type: 'boolean', description: 'Also return image crops' },
        project: PROJECT,
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'run',
    description:
      'Workbench projects (Storybook/Ladle build): capture stories and compare them to approved baselines. Default: stories affected by changes. Returns the `jux run --json` RunReport.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Capture every story' },
        since: { type: 'string', description: 'Git ref; trace changes since it' },
        stories: { type: 'array', items: { type: 'string' }, description: 'Story ids' },
      },
    },
  },
  {
    name: 'check',
    description:
      'Without capturing, list stories from the last run that still need review. Returns {ok, blocking, runId}.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'handoff',
    description:
      'A prompt describing one failing story from the last run: what changed, likely cause, image paths, next steps.',
    inputSchema: {
      type: 'object',
      properties: { story: { type: 'string', description: 'Story id' } },
      required: ['story'],
    },
  },
  {
    name: 'approve',
    description:
      'Promote the last run\'s captures of the named stories to baselines. Only when the user asks you to approve. Exact story ids; there is no "all". Returns {approved, failed}.',
    inputSchema: {
      type: 'object',
      properties: {
        stories: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Exact story ids from the last run',
        },
      },
      required: ['stories'],
    },
  },
];

const INSTRUCTIONS =
  'Visual check for UI edits. Loop: snap the page(s) before editing, edit, snap again under another name, then diff. Read the verdict summary and deltas; request crops only when `explained` is not "full". For Storybook/Ladle projects use run, check and handoff. Never approve unless the user asks.';

class ArgError extends Error {}

const str = (args: Args, key: string, required = false): string | undefined => {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ArgError(`'${key}' is required`);
    return undefined;
  }
  if (typeof v !== 'string' || v === '')
    throw new ArgError(`'${key}' must be a non-empty string`);
  return v;
};

const bool = (args: Args, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ArgError(`'${key}' must be true or false`);
  return v;
};

const strings = (args: Args, key: string): string[] | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s !== ''))
    throw new ArgError(`'${key}' must be an array of non-empty strings`);
  return v as string[];
};

/** One server: the tool handlers and the session browser. The transport is
 *  separate so tests can drive it without a process. */
export class McpServer {
  private browser: Promise<Browser> | null = null;
  private readonly project: string;

  constructor(private readonly flags: McpFlags = {}) {
    this.project = path.resolve(flags.project ?? process.cwd());
  }

  /** The session browser, re-acquired if it died (a crash, or `jux browser
   *  stop` under a warm daemon) so one bad call does not end the session. */
  private lend = async (): Promise<Browser> => {
    const current = this.browser ? await this.browser.catch(() => null) : null;
    if (current?.isConnected()) return current;
    const next = acquireBrowser({
      chrome: this.flags.chrome,
      noDaemon: this.flags['no-daemon'] === true,
    });
    this.browser = next;
    // A failed launch is reported by the call that asked; the next call retries.
    next.catch(() => {
      if (this.browser === next) this.browser = null;
    });
    return next;
  };

  async close(): Promise<void> {
    const b = this.browser ? await this.browser.catch(() => null) : null;
    this.browser = null;
    await b?.close().catch(() => {});
  }

  async call(name: string, args: Args): Promise<ToolResult> {
    try {
      switch (name) {
        case 'snap':
          return await this.snap(args);
        case 'diff':
          return await this.diff(args);
        case 'run':
          return await this.run(args);
        case 'check':
          return await this.invoke(async (s) =>
            (await import('./check.js')).checkCommand(this.common(), s),
          );
        case 'handoff': {
          const story = str(args, 'story', true)!;
          return await this.invoke(async (s) =>
            (await import('./handoff.js')).handoffCommand(story, this.common(), s),
          );
        }
        case 'approve':
          return await this.approve(args);
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
    throw new Error(`unknown tool '${name}'`);
  }

  private common() {
    return {
      json: true,
      project: this.project,
      chrome: this.flags.chrome,
      'no-daemon': this.flags['no-daemon'],
    };
  }

  private projectArg(args: Args): string {
    const p = str(args, 'project');
    return p ? path.resolve(this.project, p) : this.project;
  }

  private async snap(args: Args): Promise<ToolResult> {
    const url = str(args, 'url');
    const as = str(args, 'as');
    const urls = strings(args, 'urls');
    const asPrefix = str(args, 'asPrefix');
    if (url && urls) throw new ArgError("pass 'url' or 'urls', not both");
    if (url && !as) throw new ArgError("'url' needs 'as', the name diff will use");
    if (urls && !asPrefix)
      throw new ArgError("'urls' needs 'asPrefix', the prefix diff will use");
    if (!url && !urls?.length)
      throw new ArgError("pass 'url' with 'as', or 'urls' with 'asPrefix'");
    if (url && asPrefix) throw new ArgError("'asPrefix' goes with 'urls'; use 'as'");
    if (urls && as) throw new ArgError("'as' goes with 'url'; use 'asPrefix'");
    let viewport: string | undefined;
    if (args.viewport !== undefined) {
      const v = args.viewport as { width?: unknown; height?: unknown } | null;
      if (
        !v ||
        !Number.isInteger(v.width) ||
        !Number.isInteger(v.height) ||
        (v.width as number) < 1 ||
        (v.height as number) < 1
      )
        throw new ArgError("'viewport' must be {width, height}, integers above 0");
      viewport = `${v.width as number}x${v.height as number}`;
    }
    const waitFor = str(args, 'waitFor');
    const mask = strings(args, 'mask');
    const project = this.projectArg(args);
    const { snapCommand } = await import('./snap.js');
    return this.invoke((s) =>
      snapCommand(
        url ? [url] : urls!,
        {
          json: true,
          project,
          ...(as ? { as } : {}),
          ...(asPrefix ? { 'as-prefix': asPrefix } : {}),
          ...(viewport ? { viewport } : {}),
          ...(waitFor ? { 'wait-for': waitFor } : {}),
          ...(mask ? { mask } : {}),
        },
        { ...s, browser: this.lend },
      ),
    );
  }

  private async diff(args: Args): Promise<ToolResult> {
    const a = str(args, 'a', true)!;
    const b = str(args, 'b', true)!;
    const crops = bool(args, 'crops') === true;
    const prefix = bool(args, 'prefix') === true;
    const project = this.projectArg(args);
    const { diffCommand } = await import('./diff.js');
    const result = await this.invoke((s) =>
      diffCommand(a, b, { json: true, project, crops, prefix }, s),
    );
    if (crops && !result.isError)
      result.content.push(...(await cropImages(result, project)));
    return result;
  }

  private async run(args: Args): Promise<ToolResult> {
    const all = bool(args, 'all');
    const since = str(args, 'since');
    const stories = strings(args, 'stories');
    const { runCommand } = await import('./run.js');
    return this.invoke((s) =>
      runCommand(
        {
          ...this.common(),
          ...(all ? { all } : {}),
          ...(since ? { since } : {}),
          ...(stories?.length ? { story: stories } : {}),
        },
        { ...s, browser: this.lend },
      ),
    );
  }

  /** Explicit ids only, each one a result in the last run: an approval that
   *  matches nothing would otherwise report "nothing to approve" and look
   *  like success to an agent that mistyped an id. */
  private async approve(args: Args): Promise<ToolResult> {
    const stories = strings(args, 'stories');
    if (!stories?.length)
      throw new ArgError(
        "'stories' is required: a non-empty array of exact story ids from the last run. There is no 'all'.",
      );
    const runDir = await latestRunDir(this.project);
    if (!runDir) return errorResult('jux: no run found. Call run first.');
    const report = JSON.parse(
      await readFile(path.join(runDir, 'report.json'), 'utf8'),
    ) as { results: Array<{ storyId: string }> };
    const known = new Set(report.results.map((r) => r.storyId));
    const unknown = stories.filter((id) => !known.has(id));
    if (unknown.length)
      return errorResult(
        `jux: not in the last run: ${unknown.join(', ')}. Pass exact story ids from the run result; nothing was approved.`,
      );
    const { approveCommand } = await import('./approve.js');
    return this.invoke((s) => approveCommand({ ...this.common(), story: stories }, s));
  }

  /** Run a command with captured output and map its exit code. 2 (usage) and
   *  3 (environment) are errors; so is any non-zero exit with nothing on
   *  stdout, which is how the older commands report "no run found". A 1 with
   *  a result (changes found, stories need review) is an answer, not an error. */
  private async invoke(fn: (s: Session) => Promise<number>): Promise<ToolResult> {
    const io = captureIo();
    const code = await fn({ io });
    const out = io.stdout().trim();
    const err = io.stderr().trim();
    const isError = code >= EXIT.usage || (code !== EXIT.clean && out === '');
    const content: Content[] = [];
    if (isError && err) content.push({ type: 'text', text: err });
    if (out) content.push({ type: 'text', text: out });
    if (!isError && err) content.push({ type: 'text', text: err });
    if (content.length === 0) content.push({ type: 'text', text: `exit ${code}` });
    return { content, isError };
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The crop strips `diff --crops` wrote, as image blocks, at most MAX_CROPS
 *  (renderCrops already caps the files; this keeps the response bounded even
 *  if that changes). */
async function cropImages(result: ToolResult, project: string): Promise<Content[]> {
  const json = result.content.find((c) => c.type === 'text' && c.text.startsWith('{'));
  if (!json || json.type !== 'text') return [];
  let files: string[];
  try {
    const parsed = JSON.parse(json.text) as { crops?: Array<{ file: string }> };
    files = (parsed.crops ?? []).map((c) => c.file);
  } catch {
    return [];
  }
  const images: Content[] = [];
  for (const file of files.slice(0, MAX_CROPS)) {
    const data = await readFile(path.join(project, ...file.split('/'))).catch(() => null);
    if (data)
      images.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: 'image/png',
      });
  }
  return images;
}

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** One JSON-RPC message in, at most one out. Returns null for notifications
 *  and for responses the client sends us (we never send requests). */
export async function handleMessage(
  server: McpServer,
  msg: unknown,
  version: string,
): Promise<Json | null> {
  if (Array.isArray(msg) || typeof msg !== 'object' || msg === null)
    return rpcError(null, -32600, 'expected one JSON-RPC 2.0 object per line');
  const req = msg as Request;
  const hasId = 'id' in req && (typeof req.id === 'string' || typeof req.id === 'number');
  const id = hasId ? (req.id as string | number) : null;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string')
    return 'method' in req || hasId ? rpcError(id, -32600, 'invalid request') : null;
  if (!hasId) return null; // notifications/initialized, cancelled, …
  const params = (req.params ?? {}) as Record<string, unknown>;
  switch (req.method) {
    case 'initialize':
      // We speak one version. A client asking for another gets ours and
      // decides whether to continue, as the lifecycle spec prescribes.
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jux', version },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS as unknown as Json });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name))
        return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      const args = params.arguments ?? {};
      if (typeof args !== 'object' || args === null || Array.isArray(args))
        return rpcError(id, -32602, 'arguments must be an object');
      const result = await server.call(name, args as Args);
      return rpcResult(id, result as unknown as Json);
    }
    default:
      return rpcError(id, -32601, `method not found: ${req.method}`);
  }
}

const rpcResult = (id: string | number | null, result: Json): Json => ({
  jsonrpc: '2.0',
  id,
  result,
});

const rpcError = (id: string | number | null, code: number, message: string): Json => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

export async function mcpCommand(flags: McpFlags, version: string): Promise<number> {
  // stdout is the protocol channel. Keep a private writer for it, then point
  // process.stdout at stderr so nothing else (a stray console.log in a
  // dependency) can interleave with a JSON-RPC line and corrupt the stream.
  // console.log writes through process.stdout.write, so it is covered too.
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(
    process.stderr,
  ) as typeof process.stdout.write;
  const send = (m: Json) => writeOut(JSON.stringify(m) + '\n');

  const server = new McpServer(flags);
  // Tool calls run one at a time: they share a browser and the snaps dir,
  // and a capture is deterministic only when nothing else is loading. Ping and
  // the rest are answered at once.
  let queue: Promise<unknown> = Promise.resolve();
  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await queue.catch(() => {});
    await server.close();
    // Pipes are asynchronous on macOS: exiting now could drop the last reply.
    await new Promise<void>((r) => writeOut('', () => r()));
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, 'parse error') as Json);
      return;
    }
    const isCall = (msg as Request | null)?.method === 'tools/call';
    const respond = async () => {
      try {
        const reply = await handleMessage(server, msg, version);
        if (reply) send(reply);
      } catch (err) {
        const id = (msg as Request).id;
        send(
          rpcError(
            typeof id === 'string' || typeof id === 'number' ? id : null,
            -32603,
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    };
    if (isCall) queue = queue.then(respond);
    else void respond();
  });
  await new Promise<void>((resolve) => lines.once('close', resolve));
  await shutdown(EXIT.clean);
  return EXIT.clean;
}
