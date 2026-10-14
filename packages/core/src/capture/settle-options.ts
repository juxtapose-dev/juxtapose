// Settle options: validation, layering and the URL patterns behind
// `settle.network.ignore` / `settle.network.require`.
//
// Layers, lowest first: built-in defaults < project config < story params
// (variants included) < per call (CLI flags, MCP tool arguments). Scalars
// override; pattern lists accumulate, so a story adds to the project's ignore
// list rather than replacing it, and `require` is the way to take a request
// back out of an ignore list (both match: require wins).
//
// Pure on purpose: nothing here touches a page, so every rule has a unit test.

import type {
  CaptureFlag,
  NetworkParams,
  SettleParams,
  SettleReport,
  StoryParams,
} from '../types.js';
import { SettleConfigError } from './config-errors.js';
import { checkNetwork } from './network-policy.js';
import { checkStoryOverrides } from './story-overrides.js';

export { SettleConfigError };

/** Default cap on the settle wait. Measured on the examples (29 stories, 5
 *  runs each): the event-driven wait settles in 34-39 ms p50, 43 ms max, so
 *  the cap only matters for a page that really has outstanding work; 1500 ms
 *  lets a 1000 ms timer finish with room to paint. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 1500;
/** A cap above this is a typo, not a slow page: it would be paid per story. */
export const MAX_SETTLE_TIMEOUT_MS = 60_000;

/** `storyTimeout` bounds, ms. The top is the largest setTimeout delay (above
 *  it Node fires at once, so every story would fail after 1 ms). */
export const MIN_STORY_TIMEOUT_MS = 1000;
export const MAX_STORY_TIMEOUT_MS = 2 ** 31 - 1;
/** Timers longer than this are never waited for, at any cap. The spike
 *  measured horizon 1000 / cap 1500; the horizon must stay below the cap or a
 *  long timer is tracked and then abandoned at the cap, so it shrinks with a
 *  smaller cap (two thirds of it). */
export const MAX_TIMER_HORIZON_MS = 1000;

/** Request types that never finish while the page is open, or never affect
 *  pixels. A WebSocket handshake emits no request events today; it is listed
 *  so it stays ignored if Chrome starts reporting it. */
export const DEFAULT_NETWORK_IGNORE: readonly string[] = [
  'type:WebSocket',
  'type:EventSource',
  'type:Ping',
  'type:Prefetch',
];

/** CDP Network.ResourceType values, for `type:` validation. */
const RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'TextTrack',
  'XHR',
  'Fetch',
  'Prefetch',
  'EventSource',
  'WebSocket',
  'Manifest',
  'SignedExchange',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'FedCM',
  'Other',
] as const;

export interface UrlPattern {
  /** As written, for messages. */
  source: string;
  /** Canonical resource type, when the pattern has `type:`. */
  type?: string;
  /** Absent when the pattern is a type alone. */
  glob?: RegExp;
  /** A glob starting with `/` matches the URL's path, not the whole URL. */
  pathOnly: boolean;
}

/**
 * `[type:<ResourceType>] [<glob>]`, at least one of the two. In the glob `**`
 * matches anything, `*` anything but `/`, `?` one character but `/`. A glob
 * starting with `/` matches the path (`/api/feed`), anything else the whole
 * URL (`https://cdn.example.com/**`). Throws with the reason; the caller
 * prefixes where the pattern came from.
 */
export function parsePattern(source: string): UrlPattern {
  const tokens = source.trim().split(/\s+/).filter(Boolean);
  let type: string | undefined;
  let glob: string | undefined;
  for (const t of tokens) {
    if (/^type:/i.test(t)) {
      if (type !== undefined) throw new Error(`pattern '${source}' has two types`);
      const name = t.slice(5);
      const known = RESOURCE_TYPES.find((r) => r.toLowerCase() === name.toLowerCase());
      if (!known)
        throw new Error(
          `pattern '${source}': unknown resource type '${name}' (one of ${RESOURCE_TYPES.join(', ')})`,
        );
      type = known;
    } else {
      if (glob !== undefined)
        throw new Error(
          `pattern '${source}' has two URL globs; write one, or one pattern per glob`,
        );
      glob = t;
    }
  }
  if (type === undefined && glob === undefined)
    throw new Error('a pattern must not be empty');
  return {
    source,
    ...(type !== undefined ? { type } : {}),
    ...(glob !== undefined ? { glob: globToRegExp(glob) } : {}),
    pathOnly: glob?.startsWith('/') === true,
  };
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchPattern(
  p: UrlPattern,
  url: string,
  type: string | undefined,
): boolean {
  if (p.type !== undefined && p.type !== (type ?? 'Other')) return false;
  if (!p.glob) return true;
  if (!p.pathOnly) return p.glob.test(url);
  try {
    return p.glob.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** One layer: the options a story, the project or a call can set. */
export interface SettleLayer {
  settle?: SettleParams;
  network?: NetworkParams;
  waitForSelector?: string;
  delay?: number;
}

export interface ResolvedSettle {
  timeoutMs: number;
  horizonMs: number;
  ready: boolean;
  ignore: UrlPattern[];
  require: UrlPattern[];
}

/** Merge two `settle` objects: scalars from `over`, lists concatenated
 *  without duplicates. Keys absent from both stay absent. */
export function mergeSettle(
  under: SettleParams | undefined,
  over: SettleParams | undefined,
): SettleParams | undefined {
  if (!under) return over;
  if (!over) return under;
  const list = (a?: string[], b?: string[]) =>
    a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined;
  const ignore = list(under.network?.ignore, over.network?.ignore);
  const require = list(under.network?.require, over.network?.require);
  const timeout = over.timeout ?? under.timeout;
  const ready = over.ready ?? under.ready;
  return {
    ...(timeout !== undefined ? { timeout } : {}),
    ...(ready !== undefined ? { ready } : {}),
    ...(ignore || require
      ? { network: { ...(ignore ? { ignore } : {}), ...(require ? { require } : {}) } }
      : {}),
  };
}

/** The settle wait for one capture, from its layers, lowest first. Assumes
 *  each layer passed checkSettle. */
export function resolveSettle(
  ...layers: Array<SettleParams | undefined>
): ResolvedSettle {
  let merged: SettleParams | undefined;
  for (const l of layers) merged = mergeSettle(merged, l);
  const timeoutMs = merged?.timeout ?? DEFAULT_SETTLE_TIMEOUT_MS;
  return {
    timeoutMs,
    horizonMs: Math.min(MAX_TIMER_HORIZON_MS, Math.floor((timeoutMs * 2) / 3)),
    ready: merged?.ready === true,
    ignore: [...DEFAULT_NETWORK_IGNORE, ...(merged?.network?.ignore ?? [])].map(
      parsePattern,
    ),
    require: (merged?.network?.require ?? []).map(parsePattern),
  };
}

/** waitForSelector and delay: call > story > project. */
export function layerScalars(
  project: SettleLayer | undefined,
  params: StoryParams,
  call: SettleLayer | undefined,
): Pick<StoryParams, 'waitForSelector' | 'delay'> {
  const waitForSelector =
    call?.waitForSelector ?? params.waitForSelector ?? project?.waitForSelector;
  const delay = call?.delay ?? params.delay ?? project?.delay;
  return {
    ...(waitForSelector !== undefined ? { waitForSelector } : {}),
    ...(delay !== undefined ? { delay } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The flag a settle report raises. */
export const settleFlag = (s: Pick<SettleReport, 'status'>): CaptureFlag =>
  s.status === 'timeout' ? 'settle-timeout' : 'settle-fallback';

/** A settle cap: a whole number of ms, 1 to MAX_SETTLE_TIMEOUT_MS. The CLI
 *  and the MCP server check per-call values with this too. */
export function isSettleTimeout(v: unknown): v is number {
  return (
    Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_SETTLE_TIMEOUT_MS
  );
}

/**
 * Validate a `settle` value where it is declared, so the error names the
 * place to edit. `where` is e.g. `project config` or `story 'button--primary'`.
 * Throws SettleConfigError; returns the value typed.
 */
export function checkSettle(raw: unknown, where: string): SettleParams | undefined {
  if (raw === undefined) return undefined;
  const fail = (m: string) => new SettleConfigError(`${where}: ${m}`);
  if (!isRecord(raw)) throw fail(`'settle' must be an object`);
  for (const k of Object.keys(raw)) {
    if (k !== 'timeout' && k !== 'ready' && k !== 'network')
      throw fail(`unknown settle option '${k}' (expected timeout, ready, network)`);
  }
  if (raw['timeout'] !== undefined && !isSettleTimeout(raw['timeout']))
    throw fail(
      `settle.timeout must be a whole number of ms from 1 to ${MAX_SETTLE_TIMEOUT_MS}, got ${JSON.stringify(raw['timeout'])}`,
    );
  if (raw['ready'] !== undefined && typeof raw['ready'] !== 'boolean')
    throw fail(`settle.ready must be true or false, got ${JSON.stringify(raw['ready'])}`);
  const net = raw['network'];
  if (net !== undefined) {
    if (!isRecord(net)) throw fail(`settle.network must be an object`);
    for (const k of Object.keys(net)) {
      if (k !== 'ignore' && k !== 'require')
        throw fail(`unknown settle.network option '${k}' (expected ignore, require)`);
      checkPatterns(net[k], `settle.network.${k}`, fail);
    }
  }
  return raw;
}

/** Validate a pattern list; `fail` makes the error. */
export function checkPatterns(
  list: unknown,
  name: string,
  fail: (m: string) => Error,
): string[] {
  if (!Array.isArray(list) || !list.every((p): p is string => typeof p === 'string'))
    throw fail(`${name} must be an array of URL patterns`);
  for (const p of list) {
    try {
      parsePattern(p);
    } catch (e) {
      throw fail(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return list;
}

/** The project config's settle options: `settle`, `waitForSelector`, `delay`. */
export function checkProjectSettle(config: {
  stories?: unknown;
  settle?: unknown;
  network?: unknown;
  waitForSelector?: unknown;
  delay?: unknown;
  storyTimeout?: unknown;
}): void {
  const where = 'project config';
  const st = config.storyTimeout;
  if (
    st !== undefined &&
    (typeof st !== 'number' ||
      !Number.isInteger(st) ||
      st < MIN_STORY_TIMEOUT_MS ||
      st > MAX_STORY_TIMEOUT_MS)
  )
    throw new SettleConfigError(
      `${where}: storyTimeout must be a whole number of ms, ${MIN_STORY_TIMEOUT_MS} to ${MAX_STORY_TIMEOUT_MS}, got ${JSON.stringify(st)}`,
    );
  checkSettle(config.settle, where);
  checkNetwork(config.network, where);
  checkStoryOverrides(config.stories, where);
  if (config.waitForSelector !== undefined && typeof config.waitForSelector !== 'string')
    throw new SettleConfigError(`${where}: waitForSelector must be a CSS selector`);
  if (
    config.delay !== undefined &&
    (typeof config.delay !== 'number' ||
      !Number.isFinite(config.delay) ||
      config.delay < 0)
  )
    throw new SettleConfigError(`${where}: delay must be a number of ms, 0 or more`);
}
