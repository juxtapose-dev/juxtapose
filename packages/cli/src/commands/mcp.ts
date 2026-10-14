// `jux mcp` — a Model Context Protocol server on stdio, for coding agents that
// have no shell or that pay a browser launch per `jux` call.
//
// A skin over the commands, not a second API: every tool calls the same
// function `jux <command> --json` calls, with output captured instead of
// printed, so a tool result is the CLI's own versioned JSON (decision 6 of the
// 2026-10-12 agent toolchain spec). What MCP adds is the session: one browser
// acquired on first use and lent to every snap and run until stdin closes,
// which is the per-call launch cost an agent loop otherwise pays each turn.
// Calls that touch different snaps run in parallel on that browser;
// scheduler.ts decides which calls may overlap.
//
// Hand-rolled JSON-RPC 2.0 over newline-delimited stdio (MCP 2025-06-18),
// like the dependency-free CDP driver: the surface is five methods.

import { realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  acquireBrowser,
  checkNetwork,
  checkSettle,
  MAX_CROPS,
  MAX_SETTLE_TIMEOUT_MS,
  parseRunReport,
  type Browser,
} from '@juxtapose/core';
import type { SettleFlags } from '../settle-flags.js';
import { EXIT } from '../exit-codes.js';
import { isRecord } from '../guards.js';
import { loadConfig } from '../context.js';
import { captureIo, type Session } from '../io.js';
import { latestRunDir } from '../run-dir.js';
import {
  EXCLUSIVE,
  Scheduler,
  type Lock,
  type LockKey,
  type LockSet,
} from '../scheduler.js';
import { snapName } from '../snap-name.js';
import { MAX_VIEWPORT_SIDE } from './snap.js';

export const PROTOCOL_VERSION = '2025-06-18';

export interface McpFlags {
  project?: string;
  chrome?: string;
  'no-daemon'?: boolean;
  /** Snap calls that may capture at once; see SNAP_SLOTS. */
  concurrency?: string;
}

/** Past 16 the capture pool timed out from CPU contention on a 10-core
 *  machine (capture/pool.ts), so a larger value is a mistake, not a tuning. */
export const MAX_SNAP_SLOTS = 16;

/** The default snap pool: half the cores, at least 1 and at most SNAP_SLOTS.
 *  Half, because Chrome rasterizes on the CPU and the dev server being
 *  captured, the editor and the agent share the machine. */
export function defaultSnapSlots(cores: number = availableParallelism()): number {
  return Math.min(SNAP_SLOTS, Math.max(1, Math.floor(cores / 2)));
}

/** The snap pool size: `--concurrency`, else `mcp.concurrency` from the
 *  project config, else defaultSnapSlots. Each must be a whole number in
 *  1..MAX_SNAP_SLOTS; the error names the source that is wrong. */
export function resolveSnapSlots(
  flag: string | undefined,
  config: unknown,
  cores: number = availableParallelism(),
): { slots: number } | { error: string } {
  const fallback = defaultSnapSlots(cores);
  const range = `a whole number from 1 to ${MAX_SNAP_SLOTS} (default ${fallback})`;
  if (flag !== undefined) {
    const n = /^\d+$/.test(flag) ? Number(flag) : NaN;
    return n >= 1 && n <= MAX_SNAP_SLOTS
      ? { slots: n }
      : { error: `--concurrency must be ${range}` };
  }
  if (config === undefined) return { slots: fallback };
  return typeof config === 'number' &&
    Number.isInteger(config) &&
    config >= 1 &&
    config <= MAX_SNAP_SLOTS
    ? { slots: config }
    : { error: `mcp.concurrency in the project config must be ${range}` };
}

type RpcId = string | number | null;
/** One JSON-RPC 2.0 response line; `result` is whatever the method answers. */
type RpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string } };
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

// The config's `settle` shape, so an agent writes the same object it would
// put in juxtapose.config.json. Over the story's and the project's.
const SETTLE = {
  type: 'object',
  description:
    'Settle options for this call. A capture at the cap is flagged settle-timeout, one whose wait could not run settle-fallback; `settle.pending` says what or why',
  properties: {
    timeout: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SETTLE_TIMEOUT_MS,
      description: 'Cap on the wait, ms (default 1500)',
    },
    ready: { type: 'boolean', description: 'Wait for window.__juxtapose.ready()' },
    network: {
      type: 'object',
      properties: {
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description:
            'URL patterns never waited for, e.g. "/api/poll" or "type:Fetch **/ws*"',
        },
        require: {
          type: 'array',
          items: { type: 'string' },
          description: 'URL patterns that must complete before capture',
        },
      },
    },
  },
};

const NETWORK = {
  type: 'object',
  description:
    "Third-party requests for this call. 'block' fails requests to origins other than the page's own, so an external image neither changes nor stalls the capture",
  properties: {
    external: { type: 'string', enum: ['allow', 'block'], description: 'Default allow' },
  },
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
          properties: {
            width: { type: 'integer', minimum: 1, maximum: MAX_VIEWPORT_SIDE },
            height: { type: 'integer', minimum: 1, maximum: MAX_VIEWPORT_SIDE },
          },
          required: ['width', 'height'],
        },
        waitFor: { type: 'string', description: 'CSS selector to wait for' },
        delay: {
          type: 'integer',
          minimum: 0,
          description: 'Fixed extra wait, ms; last resort',
        },
        settle: SETTLE,
        network: NETWORK,
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
        stories: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Story ids: a story id captures it with all its variants, a capture key (id__variant) just that capture',
        },
        settle: SETTLE,
        network: NETWORK,
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
          description:
            'Exact story ids or capture keys from the last run; a story id approves all its variants',
        },
      },
      required: ['stories'],
    },
  },
];

const INSTRUCTIONS =
  'Visual check for UI edits. Loop: snap the page(s) before editing, edit, snap again under another name, then diff. Read the verdict summary and deltas; request crops only when `explained` is not "full". For Storybook/Ladle projects use run, check and handoff. Never approve unless the user asks.';

class ArgError extends Error {}
class UnknownTool extends Error {}

const CANCELLED = 'jux: cancelled before it started';
const SHUTTING_DOWN = 'jux: the server is shutting down';

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

/** The `settle` argument as the CLI flags that carry it, checked like the
 *  config's own (the error names the argument). */
function settleArg(args: Args): SettleFlags {
  let settle;
  let network;
  try {
    settle = checkSettle(args['settle'] ?? undefined, "'settle'");
    network = checkNetwork(args['network'] ?? undefined, "'network'");
  } catch (e) {
    throw new ArgError((e as Error).message.replace(/^jux: /, ''));
  }
  const net: SettleFlags = network?.external
    ? { 'network-external': network.external }
    : {};
  if (!settle) return net;
  return {
    ...net,
    ...(settle.timeout !== undefined ? { 'settle-timeout': String(settle.timeout) } : {}),
    ...(settle.ready === true ? { 'settle-ready': true } : {}),
    ...(settle.ready === false ? { 'no-settle-ready': true } : {}),
    ...(settle.network?.ignore?.length ? { 'settle-ignore': settle.network.ignore } : {}),
    ...(settle.network?.require?.length
      ? { 'settle-require': settle.network.require }
      : {}),
  };
}

const bool = (args: Args, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ArgError(`'${key}' must be true or false`);
  return v;
};

const strings = (args: Args, key: string): string[] | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (
    !Array.isArray(v) ||
    !v.every((s): s is string => typeof s === 'string' && s !== '')
  )
    throw new ArgError(`'${key}' must be an array of non-empty strings`);
  return v;
};

/** A validated call: the locks it needs, and the work to run once they are
 *  granted. Arguments are checked before queueing, so a bad call answers at
 *  once instead of waiting behind a run. */
interface Planned {
  locks: LockSet;
  exec: (signal?: AbortSignal) => Promise<ToolResult>;
}

/** The most snap calls the default lets capture at once (defaultSnapSlots
 *  takes half the cores, up to this); more wait for a slot. `--concurrency`
 *  and `mcp.concurrency` set it outright.
 *
 *  Each snap opens its own browser context in the one session browser, and
 *  Chrome rasterizes on the CPU (browser/flags.ts), so parallel snaps share
 *  cores. Measured 2026-10-13 on a 15-core M5 Pro, example Storybook stories
 *  at 800x600, through `jux mcp` over stdio, median of 5:
 *
 *    4 snaps   serial    parallel
 *    daemon    1028 ms   299 ms
 *    private   1048 ms   303 ms   (JUX_NO_DAEMON=1)
 *
 *  8 snap calls at once, by slot limit (wall / median capture time):
 *  1: 2109 / 222 ms, 2: 1055 / 223, 4: 604 / 242, 8: 338 / 266. A snap is
 *  mostly settle waits, so on this machine 8 was faster still; the default
 *  stops at 4 anyway because a call may carry many urls (one slot, several pages),
 *  the capture pool measured CPU contention turning into settle timeouts at
 *  16 workers on 10 cores (capture/pool.ts), and an agent's dev server and
 *  editor share the machine. The config sets it higher where that is
 *  measured to help. */
export const SNAP_SLOTS = 4;

/** One server: the tool handlers, the scheduler and the session browser.
 *  The transport is separate so tests can drive it without a process. */
export class McpServer {
  private browser: Promise<Browser> | null = null;
  private lending: Promise<Browser> | null = null;
  private closed = false;
  private readonly project: string;
  private readonly scheduler: Scheduler;

  constructor(
    private readonly flags: McpFlags = {},
    opts: { snapSlots?: number } = {},
  ) {
    // Real path, so the containment check below compares like with like on a
    // machine where the root itself sits under a symlink (macOS /tmp).
    const root = path.resolve(flags.project ?? process.cwd());
    try {
      this.project = realpathSync.native(root);
    } catch {
      this.project = root;
    }
    this.scheduler = new Scheduler({ snap: opts.snapSlots ?? defaultSnapSlots() });
  }

  /** The session browser, re-acquired if it died (a crash, or `jux browser
   *  stop` under a warm daemon) so one bad call does not end the session.
   *
   *  Single flight: parallel snaps that all find the browser dead must share
   *  one replacement. Each deciding on its own would launch one browser per
   *  call and keep only the last; the others' processes and temp profiles
   *  would outlive the session. */
  private lend = (): Promise<Browser> => {
    // After close(), a straggling call must not launch a browser that nothing
    // will ever close.
    if (this.closed) return Promise.reject(new Error(SHUTTING_DOWN));
    if (!this.lending) {
      const p = this.reacquire();
      this.lending = p;
      void p
        .finally(() => {
          if (this.lending === p) this.lending = null;
        })
        .catch(() => {});
    }
    return this.lending;
  };

  private async reacquire(): Promise<Browser> {
    const current = this.browser ? await this.browser.catch(() => null) : null;
    if (current?.isConnected()) return current;
    // Dead but not closed: close() still reaps a private launch's process and
    // deletes its temp profile, which a crash leaves behind.
    if (current) await current.close().catch(() => {});
    if (this.closed) throw new Error(SHUTTING_DOWN);
    const next = acquireBrowser({
      chrome: this.flags.chrome,
      noDaemon: this.flags['no-daemon'] === true,
    });
    this.browser = next;
    // A failed launch is reported by the calls that asked; the next call retries.
    next.catch(() => {
      if (this.browser === next) this.browser = null;
    });
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
    // A reacquire in progress lands in this.browser; wait for it so it is the
    // one closed below, not one that outlives the session.
    await this.lending?.catch(() => {});
    const b = this.browser ? await this.browser.catch(() => null) : null;
    this.browser = null;
    await b?.close().catch(() => {});
  }

  /** Validate, wait for the call's locks, run it, release. A call cancelled
   *  while it waits never starts. One cancelled while it runs keeps its locks
   *  until it settles: only run can stop early, and leftover snap or diff
   *  work must not overlap a call that touches the same files. */
  async call(name: string, args: Args, signal?: AbortSignal): Promise<ToolResult> {
    // The place in line is taken now, before planning awaits anything, so
    // conflicting calls are granted in the order they arrived.
    const ticket = this.scheduler.ticket();
    let planned: Planned;
    try {
      planned = await this.plan(name, args);
    } catch (err) {
      ticket.cancel();
      if (err instanceof UnknownTool) throw err;
      return errorResult(err instanceof Error ? err.message : String(err));
    }
    const release = await ticket.acquire(planned.locks, signal);
    if (!release) return errorResult(CANCELLED);
    // Granted in the same turn as its signal aborted (a shutdown aborts every
    // call in one loop): it was cancelled before it started, so it must not.
    if (signal?.aborted) {
      release();
      return errorResult(CANCELLED);
    }
    try {
      return await planned.exec(signal);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    } finally {
      release();
    }
  }

  private async plan(name: string, args: Args): Promise<Planned> {
    switch (name) {
      case 'snap':
        return this.snap(args);
      case 'diff':
        return this.diff(args);
      case 'run':
        return this.run(args);
      case 'check':
        return {
          locks: this.readsRun(),
          exec: (signal) =>
            this.invoke(
              async (s) => (await import('./check.js')).checkCommand(this.common(), s),
              signal,
            ),
        };
      case 'handoff': {
        const story = str(args, 'story', true)!;
        return {
          locks: this.readsRun(),
          exec: (signal) =>
            this.invoke(
              async (s) =>
                (await import('./handoff.js')).handoffCommand(story, this.common(), s),
              signal,
            ),
        };
      }
      case 'approve':
        return this.approve(args);
    }
    throw new UnknownTool(`unknown tool '${name}'`);
  }

  /** check and handoff read the last run, which run and approve write. */
  private readsRun(): LockSet {
    return {
      locks: [{ key: { kind: 'key', project: this.project, key: 'run' }, mode: 'read' }],
    };
  }

  private common() {
    return {
      json: true,
      project: this.project,
      chrome: this.flags.chrome,
      'no-daemon': this.flags['no-daemon'],
    };
  }

  /** A tool's `project`, confined to the server's root. The CLI trusts its
   *  own arguments because the user typed them; a tool argument comes from a
   *  model that may be reading attacker-controlled page text, so it must not
   *  steer writes (snaps, crops) or reads anywhere else on the machine. The
   *  real path is checked, so a symlink inside the root cannot point out. */
  private async projectArg(args: Args): Promise<string> {
    const p = str(args, 'project');
    if (!p) return this.project;
    const real = await realpath(path.resolve(this.project, p)).catch(() => null);
    if (!real) throw new ArgError(`'project' ${p} does not exist`);
    if (!isInside(real, this.project, true))
      throw new ArgError(
        `'project' must be the server's project (${this.project}) or a directory inside it; restart the server with --project to use another`,
      );
    // jux's own scratch and baselines: a project there would put snaps and
    // crops among the files run and approve own, outside any lock.
    if (path.relative(this.project, real).split(path.sep).includes('.juxtapose'))
      throw new ArgError(`'project' must not be inside a .juxtapose directory; got ${p}`);
    return real;
  }

  private async snap(args: Args): Promise<Planned> {
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
      const v = args.viewport;
      // Shape only; snapCommand owns the range, so the CLI and the tool agree.
      if (
        typeof v !== 'object' ||
        v === null ||
        !('width' in v && 'height' in v) ||
        typeof v.width !== 'number' ||
        typeof v.height !== 'number'
      )
        throw new ArgError("'viewport' must be {width, height}");
      viewport = `${v.width}x${v.height}`;
    }
    const waitFor = str(args, 'waitFor');
    const mask = strings(args, 'mask');
    const settle = settleArg(args);
    const delay = args['delay'];
    if (
      delay !== undefined &&
      delay !== null &&
      !(Number.isSafeInteger(delay) && (delay as number) >= 0)
    )
      throw new ArgError("'delay' must be a whole number of ms, 0 or more");
    const project = await this.projectArg(args);
    // The names snapCommand will write: `as`, or every `<asPrefix>-<slug>`
    // plus `<asPrefix>.set.json`, normalized by the same snapName.
    const key: LockKey = as
      ? { kind: 'name', project, name: snapName(as, as) }
      : { kind: 'prefix', project, prefix: snapName(asPrefix!, asPrefix) };
    // Parallel snaps share the browser but never a context or page: each
    // snapPages call opens its own context and disposes it (core
    // capture/snap.ts), the isolation the run pool already relies on.
    return {
      locks: { locks: [{ key, mode: 'write' }], slot: 'snap' },
      exec: async (signal) => {
        const { snapCommand } = await import('./snap.js');
        return this.invoke(
          (s) =>
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
                ...(typeof delay === 'number' ? { delay: String(delay) } : {}),
                ...settle,
              },
              { ...s, browser: this.lend },
            ),
          signal,
        );
      },
    };
  }

  private async diff(args: Args): Promise<Planned> {
    // Names only. The CLI also takes `.webp` paths, which would let a tool
    // call read (and decode, and crop) any image on the machine.
    const a = snapRef(args, 'a');
    const b = snapRef(args, 'b');
    const crops = bool(args, 'crops') === true;
    const prefix = bool(args, 'prefix') === true;
    const project = await this.projectArg(args);
    const { diffCommand, cropDirName } = await import('./diff.js');
    // Reads both sides, as diffCommand resolves them; crops also rewrite the
    // pair's own crops dir, which a second diff of the same pair would empty.
    const side = (ref: string): LockKey =>
      prefix
        ? { kind: 'prefix', project, prefix: snapName(ref, ref) }
        : { kind: 'name', project, name: snapName(ref, ref) };
    const locks: Lock[] = [
      { key: side(a), mode: 'read' },
      { key: side(b), mode: 'read' },
    ];
    if (crops)
      locks.push({
        key: { kind: 'key', project, key: `crops/${cropDirName(a, b)}` },
        mode: 'write',
      });
    return {
      locks: { locks },
      exec: async (signal) => {
        const result = await this.invoke(
          (s) => diffCommand(a, b, { json: true, project, crops, prefix }, s),
          signal,
        );
        if (crops && !result.isError)
          result.content.push(...(await cropImages(result, project)));
        return result;
      },
    };
  }

  /** run captures with a worker pool of its own and rewrites the last run:
   *  exclusive, so no snap shares the CPU with its captures and no
   *  check/handoff/approve reads a half-written run. */
  private run(args: Args): Planned {
    const all = bool(args, 'all');
    const since = str(args, 'since');
    const stories = strings(args, 'stories');
    const settle = settleArg(args);
    return {
      locks: EXCLUSIVE,
      exec: async (signal) => {
        const { runCommand } = await import('./run.js');
        return this.invoke(
          (s) =>
            runCommand(
              {
                ...this.common(),
                ...(all ? { all } : {}),
                ...(since ? { since } : {}),
                ...(stories?.length ? { story: stories } : {}),
                ...settle,
              },
              { ...s, browser: this.lend },
            ),
          signal,
        );
      },
    };
  }

  /** Explicit ids only, each one a result in the last run: an approval that
   *  matches nothing would otherwise report "nothing to approve" and look
   *  like success to an agent that mistyped an id. Exclusive: it writes
   *  baselines and the manifest, which the next run reads. */
  private approve(args: Args): Planned {
    const stories = strings(args, 'stories');
    if (!stories?.length)
      throw new ArgError(
        "'stories' is required: a non-empty array of exact story ids from the last run. There is no 'all'.",
      );
    return {
      locks: EXCLUSIVE,
      exec: async (signal) => {
        // Resolved once, under the lock: validation and approval must read the
        // same run even if another process writes a newer one in between.
        const runDir = await latestRunDir(this.project);
        if (!runDir) return errorResult('jux: no run found. Call the run tool first.');
        const report = parseRunReport(
          await readFile(path.join(runDir, 'report.json'), 'utf8'),
        );
        // A base id is known when any of its variants is in the run.
        const known = new Set(
          report.results.flatMap((r) =>
            r.baseStoryId !== undefined ? [r.storyId, r.baseStoryId] : [r.storyId],
          ),
        );
        const unknown = stories.filter((id) => !known.has(id));
        if (unknown.length)
          return errorResult(
            `jux: not in the last run: ${unknown.join(', ')}. Pass exact story ids from the run result; nothing was approved.`,
          );
        const { approveCommand } = await import('./approve.js');
        return this.invoke(
          (s) => approveCommand({ ...this.common(), run: runDir, story: stories }, s),
          signal,
        );
      },
    };
  }

  /** Run a command with captured output and map its exit code. 2 (usage) and
   *  3 (environment) are errors; so is any non-zero exit with nothing on
   *  stdout, which is how the older commands report "no run found". A 1 with
   *  a result (changes found, stories need review) is an answer, not an error. */
  private async invoke(
    fn: (s: Session) => Promise<number>,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    const io = captureIo();
    const code = await fn({ io, ...(signal ? { signal } : {}) });
    const out = io.stdout().trim();
    const err = toolWording(io.stderr().trim());
    const isError = code >= EXIT.usage || (code !== EXIT.clean && out === '');
    const content: Content[] = [];
    if (isError && err) content.push({ type: 'text', text: err });
    if (out) content.push({ type: 'text', text: out });
    if (!isError && err) content.push({ type: 'text', text: err });
    if (content.length === 0)
      content.push({
        type: 'text',
        text: `jux: the command printed nothing (exit ${code})`,
      });
    return { content, isError };
  }
}

/** A diff side: a snap name, never a path. Anything path-like is refused;
 *  the rest goes to diffCommand, which normalizes it with the same snapName()
 *  snap applied to `as`, so `as: "Before"` and `a: "Before"` meet at `before`. */
function snapRef(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new ArgError(`'${key}' is required`);
  if (v === '' || /[/\\\0]/.test(v) || v.includes('..') || /\.webp$/i.test(v))
    throw new ArgError(
      `'${key}' must be a snap name, such as the 'name' a snap result returned, not a path; got '${v}'`,
    );
  return v;
}

/** `child` is `dir` or below it. Both must be real paths. */
function isInside(child: string, dir: string, orEqual = false): boolean {
  if (orEqual && child === dir) return true;
  return child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** CLI hints name shell commands; an MCP client may have no shell, so error
 *  text names the tool to call instead. Applied to tool output only. */
const TOOL_WORDING: Array<[RegExp, string]> = [
  [/Run `jux run` first\./g, 'Call the run tool first.'],
  [
    /--crops takes one pair at a time\..*$/gm,
    'crops takes one pair at a time. Call diff with prefix first, then diff with a single pair and crops: true.',
  ],
  [
    /--viewport must be WxH, each 1 to (\d+), got '[^']*'\..*$/gm,
    "'viewport' width and height must each be 1 to $1.",
  ],
  [
    /Run `jux snap <url>(?:…)? --as(?:-prefix)? ([^`]+)` first\./g,
    'Call snap with that name ($1) first.',
  ],
];

export function toolWording(text: string): string {
  return TOOL_WORDING.reduce((t, [re, to]) => t.replace(re, to), text);
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: toolWording(message) }], isError: true };
}

/** The crop strips `diff --crops` wrote, as image blocks, at most MAX_CROPS
 *  (renderCrops already caps the files; this keeps the response bounded even
 *  if that changes). */
export async function cropImages(
  result: ToolResult,
  project: string,
): Promise<Content[]> {
  const json = result.content.find((c) => c.type === 'text' && c.text.startsWith('{'));
  if (!json || json.type !== 'text') return [];
  let files: string[];
  try {
    const parsed: unknown = JSON.parse(json.text);
    if (!isRecord(parsed)) return [];
    const crops = parsed['crops'] ?? [];
    if (!Array.isArray(crops)) return [];
    // A crop without a string file is skipped (it used to fail the path join below).
    files = crops.flatMap((c) =>
      isRecord(c) && typeof c['file'] === 'string' ? [c['file']] : [],
    );
  } catch {
    return [];
  }
  // Only files the crops step wrote: the paths come from JSON, and a crops
  // dir swapped for a symlink must not turn this into a file reader.
  const cropsRoot = await realpath(path.join(project, '.juxtapose', 'crops')).catch(
    () => null,
  );
  if (!cropsRoot || !isInside(cropsRoot, project)) return [];
  const images: Content[] = [];
  for (const file of files.slice(0, MAX_CROPS)) {
    const real = await realpath(path.join(project, ...file.split('/'))).catch(() => null);
    if (!real || !isInside(real, cropsRoot)) continue;
    const data = await readFile(real).catch(() => null);
    if (data)
      images.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: 'image/png',
      });
  }
  return images;
}

/** One JSON-RPC message in, at most one out. Returns null for notifications
 *  and for responses the client sends us (we never send requests). */
export async function handleMessage(
  server: McpServer,
  msg: unknown,
  version: string,
  signal?: AbortSignal,
): Promise<RpcResponse | null> {
  if (!isRecord(msg))
    return rpcError(null, -32600, 'expected one JSON-RPC 2.0 object per line');
  const req = msg;
  // A response from the client: we send no requests, so there is nothing to
  // match it to, and answering a response is itself a protocol error.
  if (!('method' in req) && ('result' in req || 'error' in req)) return null;
  const rawId = req['id'];
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const hasId = id !== null;
  // MCP ids are strings or numbers, never null; an `id` of another type is a
  // malformed request, and dropping it would leave the client waiting.
  if ('id' in req && !hasId)
    return rpcError(null, -32600, 'id must be a string or number');
  const method = req['method'];
  if (req['jsonrpc'] !== '2.0' || typeof method !== 'string')
    return rpcError(id, -32600, 'invalid request');
  if (!hasId) return null; // notifications/initialized, cancelled, …
  const params = isRecord(req['params']) ? req['params'] : {};
  switch (method) {
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
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name))
        return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      const args = params.arguments ?? {};
      if (!isRecord(args)) return rpcError(id, -32602, 'arguments must be an object');
      const result = await server.call(name, args, signal);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

const rpcResult = (id: RpcId, result: unknown): RpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
});

const rpcError = (id: RpcId, code: number, message: string): RpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const SIGNALS = { SIGINT: 2, SIGTERM: 15 } as const;

export async function mcpCommand(flags: McpFlags, version: string): Promise<number> {
  const config = await loadConfig(path.resolve(flags.project ?? process.cwd()));
  const pool = resolveSnapSlots(flags.concurrency, config.mcp?.concurrency);
  if ('error' in pool) {
    process.stderr.write(`jux mcp: ${pool.error}.\n`);
    return EXIT.usage;
  }
  const snapSlots = pool.slots;
  // stdout is the protocol channel. Keep a private writer for it, then point
  // process.stdout at stderr so nothing else (a stray console.log in a
  // dependency) can interleave with a JSON-RPC line and corrupt the stream.
  // console.log writes through process.stdout.write, so it is covered too.
  const stdout = process.stdout;
  const writeOut = stdout.write.bind(stdout);
  stdout.write = process.stderr.write.bind(process.stderr);
  let outBroken = false;
  const send = (m: RpcResponse) => {
    if (!outBroken) writeOut(JSON.stringify(m) + '\n');
  };

  const server = new McpServer(flags, { snapSlots });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Tool calls run concurrently; McpServer.call holds each one until the
  // scheduler grants the files and browser time it needs (see scheduler.ts).
  // Ping and the rest are answered at once.
  /** Calls not settled yet, so stdin EOF can wait for every one of them. */
  const inFlight = new Set<Promise<void>>();
  /** Calls not yet answered, by request id, for notifications/cancelled. */
  const pending = new Map<string | number, AbortController>();
  let shuttingDown = false;

  const exit = async (code: number, drain: Promise<unknown>): Promise<never> => {
    await drain.catch(() => {});
    // Bounded: a browser that will not close must not hold the process.
    await Promise.race([server.close(), delay(2000)]);
    // Pipes are asynchronous on macOS: exiting now could drop the last reply.
    if (!outBroken)
      await Promise.race([
        new Promise<void>((r) => writeOut('', () => r())),
        delay(1000),
      ]);
    process.exit(code);
  };
  const stopReading = () => {
    shuttingDown = true;
    lines.close();
    process.stdin.pause();
  };

  // The client went away (EPIPE). Nobody can read a reply, so stop now.
  stdout.on('error', () => {
    outBroken = true;
    if (shuttingDown) return;
    stopReading();
    for (const c of pending.values()) c.abort();
    void exit(EXIT.failure, Promise.resolve());
  });

  // A signal ends the session now: no new calls, every call in flight aborted
  // and not answered. Queued calls never start; running ones fail when the
  // browser closes under them. A second signal
  // means the shutdown itself is stuck.
  for (const [name, num] of Object.entries(SIGNALS)) {
    process.on(name, () => {
      if (shuttingDown) process.exit(128 + num);
      stopReading();
      for (const c of pending.values()) c.abort();
      void exit(128 + num, Promise.resolve());
    });
  }

  const onCall = (id: string | number, msg: unknown) => {
    // Ids must be unique per session. A second call under an id still in
    // flight would take over its cancellation entry, so cancelling one would
    // cancel the other, and the first to finish would delete both.
    if (pending.has(id)) {
      send(
        rpcError(
          id,
          -32600,
          `request id ${JSON.stringify(id)} is already in use by a call in progress`,
        ),
      );
      return;
    }
    const controller = new AbortController();
    pending.set(id, controller);
    const { signal } = controller;
    const done = (async () => {
      try {
        // Cancelled while queued: McpServer.call never starts it. Cancelled
        // while running: it keeps its locks until it settles. Either way its
        // reply is dropped, as the cancellation spec requires.
        const reply = await handleMessage(server, msg, version, signal);
        if (reply && !signal.aborted) send(reply);
      } catch (err) {
        if (!signal.aborted)
          send(rpcError(id, -32603, err instanceof Error ? err.message : String(err)));
      } finally {
        pending.delete(id);
      }
    })();
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
  };

  lines.on('line', (line) => {
    if (shuttingDown || !line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, 'parse error'));
      return;
    }
    const req = isRecord(msg) ? msg : undefined;
    if (req?.['method'] === 'notifications/cancelled') {
      const p = req['params'];
      const id = isRecord(p) ? p['requestId'] : undefined;
      if (typeof id === 'string' || typeof id === 'number') pending.get(id)?.abort();
      return;
    }
    const id = req?.['id'];
    if (
      req?.['method'] === 'tools/call' &&
      req['jsonrpc'] === '2.0' &&
      (typeof id === 'string' || typeof id === 'number')
    ) {
      onCall(id, msg);
      return;
    }
    void handleMessage(server, msg, version).then(
      (reply) => {
        if (reply) send(reply);
      },
      (err: unknown) =>
        send(rpcError(null, -32603, err instanceof Error ? err.message : String(err))),
    );
  });
  await new Promise<void>((resolve) => lines.once('close', resolve));
  // A signal or a broken stdout closed the input; that path owns the exit.
  if (shuttingDown) return new Promise<never>(() => {});
  shuttingDown = true;
  return exit(EXIT.clean, Promise.allSettled([...inFlight]));
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
