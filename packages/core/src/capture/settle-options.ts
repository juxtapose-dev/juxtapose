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
  SettleParams,
  SettleFlag,
  SettleReport,
  Snapshot,
  StoryParams,
} from '../types.js';
import {
  ProjectRuntimeSchema,
  SettleSchema,
  URL_PATTERN_FORMAT,
  withText,
  type FreezeParams,
  type NetworkParams,
} from '../config/schema.js';
import { configError, fits, validate } from '../config/validate.js';
import { Type } from '@sinclair/typebox/type';
import { SettleConfigError } from './config-errors.js';
import { checkRulePlaceholders } from './network-rules.js';
import { parsePattern, type UrlPattern } from './url-pattern.js';

/** Default cap on the settle wait. Measured on the examples (29 stories, 5
 *  runs each): the event-driven wait settles in 34-39 ms p50, 43 ms max, so
 *  the cap only matters for a page that really has outstanding work; 1500 ms
 *  lets a 1000 ms timer finish with room to paint. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 1500;
export {
  MAX_SETTLE_TIMEOUT_MS,
  MIN_STORY_TIMEOUT_MS,
  MAX_STORY_TIMEOUT_MS,
} from '../config/schema.js';
export {
  RESOURCE_TYPES,
  parsePattern,
  globToRegExp,
  matchPattern,
  type UrlPattern,
} from './url-pattern.js';
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

/** One layer: the options a story, the project or a call can set. */
export interface SettleLayer {
  settle?: SettleParams;
  network?: NetworkParams;
  freeze?: FreezeParams;
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

/** Layers of `settle`, lowest first, merged as resolveSettle does. */
export function mergeSettleLayers(
  ...layers: Array<SettleParams | undefined>
): SettleParams | undefined {
  let merged: SettleParams | undefined;
  for (const l of layers) merged = mergeSettle(merged, l);
  return merged;
}

/** The settle wait for one capture, from its layers, lowest first. Assumes
 *  each layer passed checkSettle. */
export function resolveSettle(
  ...layers: Array<SettleParams | undefined>
): ResolvedSettle {
  const merged = mergeSettleLayers(...layers);
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

/** The flag a settle report raises. */
export const settleFlag = (s: Pick<SettleReport, 'status'>): SettleFlag =>
  s.status === 'timeout' ? 'settle-timeout' : 'settle-fallback';

/** Every flag a capture raises; empty when it raised none. */
export const captureFlags = (
  s: Pick<Snapshot, 'settle' | 'rendererReused'>,
): CaptureFlag[] => [
  ...(s.settle ? [settleFlag(s.settle)] : []),
  ...(s.rendererReused ? (['renderer-reused'] as const) : []),
];

/** A settle cap: a whole number of ms, 1 to MAX_SETTLE_TIMEOUT_MS. The CLI
 *  and the MCP server check per-call values with this too. */
export function isSettleTimeout(v: unknown): v is number {
  return fits(SettleSchema.properties.timeout, v);
}

/**
 * Validate a `settle` value where it is declared, so the error names the
 * place to edit. `where` is e.g. `project config` or `story 'button--primary'`.
 * Throws SettleConfigError; returns the value typed.
 */
export function checkSettle(raw: unknown, where: string): SettleParams | undefined {
  if (raw === undefined) return undefined;
  return validate<SettleParams>(SettleSchema, raw, where);
}

/** Validate a pattern list named `name` (a CLI flag); `fail` makes the error. */
export function checkPatterns(
  list: unknown,
  name: string,
  fail: (m: string) => Error,
): string[] {
  const schema = withText(Type.Array(Type.String({ format: URL_PATTERN_FORMAT })), {
    type: `${name} must be an array of URL patterns`,
    format: `${name}: {reason}`,
  });
  const err = configError(schema, list);
  if (err) throw fail(err.message);
  return list as string[];
}

/** The project config's capture options: `freshRenderer`, `storyTimeout`,
 *  `settle`, `network`, `stories`, `waitForSelector`, `delay`. */
export function checkProjectSettle(config: unknown): void {
  // A config that isn't an object has never been refused here (each option
  // read as absent); keep it that way.
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return;
  const c = validate<{
    network?: NetworkParams;
    stories?: Record<string, { network?: NetworkParams }>;
  }>(ProjectRuntimeSchema, config, 'project config');
  checkRulePlaceholders(c.network?.rules, 'project config');
  for (const [glob, o] of Object.entries(c.stories ?? {}))
    checkRulePlaceholders(o.network?.rules, `project config: stories '${glob}'`);
}

export { SettleConfigError };
