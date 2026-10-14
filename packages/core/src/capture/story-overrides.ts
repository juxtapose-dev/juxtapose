// Per-story overrides in the project config (issue #128): `stories: { "<id
// glob>": { skip, mask, delay, ... } }`, for a workbench you don't own, where
// `parameters.juxtapose` can't be edited.
//
// Layers, lowest first: project defaults < story `parameters.juxtapose`
// (variants included) < config override < per call (CLI flags, MCP
// arguments). The override sits ABOVE the story on purpose: it is the project
// owner's word about a story they can't edit, and the point of it is to
// correct what the story declares (a `delay` that is too short, a `skip`
// that has to go). It also has to survive live params, which are read after
// render and otherwise replace manifest params. Pure: nothing here touches a
// page.
//
// Several globs can match one capture. Order, least to most specific, later
// wins: patterns with wildcards before exact ids; then fewer literal
// characters before more (`a--*` loses to `a--b-*`); then earlier in the
// file before later. Scalars: last wins. `mask` unions. `settle` and
// `network` merge field by field (settle.network lists concatenate).

import type { StoryManifest, StoryOverride, StoryParams } from '../types.js';
import { VariantConfigError } from './config-errors.js';
import { checkNetwork } from './network-policy.js';
import { checkSettle, globToRegExp, mergeSettle } from './settle-options.js';

const KEYS = [
  'skip',
  'mask',
  'delay',
  'waitForSelector',
  'captureTimeout',
  'settle',
  'network',
  'threshold',
  'minDiffPercent',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isWild = (glob: string) => /[*?]/.test(glob);

/** Validate `stories` where it is declared. `where` names the config (e.g.
 *  `project config`); each message names the glob and the key. */
export function checkStoryOverrides(
  raw: unknown,
  where = 'project config',
): Record<string, StoryOverride> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new VariantConfigError(
      `${where}: 'stories' must be an object of story id globs`,
    );
  }
  for (const [glob, spec] of Object.entries(raw)) {
    const at = `${where}: stories['${glob}']`;
    const fail = (m: string) => new VariantConfigError(`${at}: ${m}`);
    if (glob.trim() === '') throw fail(`the story id glob must not be empty`);
    if (!isRecord(spec)) throw fail(`must be an object of capture settings`);
    for (const k of Object.keys(spec)) {
      if (!(KEYS as readonly string[]).includes(k))
        throw fail(`unknown option '${k}' (expected ${KEYS.join(', ')})`);
    }
    if (spec['skip'] !== undefined && typeof spec['skip'] !== 'boolean')
      throw fail(`skip must be true or false, got ${JSON.stringify(spec['skip'])}`);
    const mask = spec['mask'];
    if (
      mask !== undefined &&
      (!Array.isArray(mask) || !mask.every((m) => typeof m === 'string' && m !== ''))
    )
      throw fail(`mask must be an array of selectors`);
    const num = (k: string, ok: (n: number) => boolean, what: string) => {
      const v = spec[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)))
        throw fail(`${k} must be ${what}, got ${JSON.stringify(v)}`);
    };
    num('delay', (n) => n >= 0, 'a number of ms, 0 or more');
    num('captureTimeout', (n) => n > 0, 'a number of ms above 0');
    num('threshold', (n) => n >= 0 && n <= 1, 'a number from 0 to 1');
    num('minDiffPercent', (n) => n >= 0 && n <= 100, 'a percentage from 0 to 100');
    const w = spec['waitForSelector'];
    if (w !== undefined && (typeof w !== 'string' || w === ''))
      throw fail(`waitForSelector must be a CSS selector`);
    checkSettle(spec['settle'], at);
    checkNetwork(spec['network'], at);
  }
  return raw as Record<string, StoryOverride>;
}

export interface CompiledOverride {
  glob: string;
  re: RegExp;
  spec: StoryOverride;
  /** Sort key: exact ids, then literal length, then file position. */
  rank: [number, number, number];
}

/** Compile validated overrides. Empty or absent gives an empty list. */
export function compileOverrides(
  stories: Record<string, StoryOverride> | undefined,
): CompiledOverride[] {
  return Object.entries(stories ?? {}).map(([glob, spec], i) => ({
    glob,
    re: globToRegExp(glob),
    spec,
    rank: [isWild(glob) ? 0 : 1, glob.replace(/[*?]/g, '').length, i],
  }));
}

export interface ResolvedOverride {
  override: StoryOverride;
  /** Every matching glob, least specific first. */
  matched: string[];
  /** The matching globs that set `skip: true`, when the result skips. */
  skippedBy: string[];
}

/** The merged override for one capture, or undefined when no glob matches.
 *  A glob matches the capture key, or the base id of a variant capture. */
export function resolveOverride(
  compiled: readonly CompiledOverride[],
  capture: { storyId: string; baseStoryId?: string },
): ResolvedOverride | undefined {
  const hits = compiled
    .filter(
      (c) =>
        c.re.test(capture.storyId) ||
        (capture.baseStoryId !== undefined && c.re.test(capture.baseStoryId)),
    )
    .sort(
      (a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2],
    );
  if (hits.length === 0) return undefined;
  let override: StoryOverride = {};
  for (const h of hits) override = applyOverride(override, h.spec);
  return {
    override,
    matched: hits.map((h) => h.glob),
    skippedBy:
      override.skip === true
        ? hits.filter((h) => h.spec.skip === true).map((h) => h.glob)
        : [],
  };
}

/** Fold an override into params; the override wins. Masks union, `settle` and
 *  `network` merge field by field, everything else replaces. */
export function applyOverride<T extends StoryParams>(
  params: T,
  override: StoryOverride | undefined,
): T {
  if (!override) return params;
  const { mask, settle, network, ...scalars } = override;
  const out: T = { ...params, ...scalars };
  if (params.mask || mask)
    out.mask = [...new Set([...(params.mask ?? []), ...(mask ?? [])])];
  const s = mergeSettle(params.settle, settle);
  if (s) out.settle = s;
  if (params.network || network) out.network = { ...params.network, ...network };
  return out;
}

/** One capture with the matching override folded into `params` and noted on
 *  the manifest (`override` for live params to re-apply, `skippedBy` for the
 *  report). `params` is what the capture would have had without it. */
export function withOverride(
  story: StoryManifest,
  params: StoryParams,
  compiled: readonly CompiledOverride[],
): StoryManifest {
  const r = resolveOverride(compiled, story);
  if (!r) return { ...story, params };
  const next: StoryManifest = {
    ...story,
    params: applyOverride(params, r.override),
    override: r.override,
  };
  if (r.skippedBy.length > 0) next.skippedBy = r.skippedBy;
  return next;
}
