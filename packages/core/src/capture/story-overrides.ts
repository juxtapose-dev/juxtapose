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
// wins: keys that name no variant before keys that do (`__` in the key: a
// variant-targeting key is the narrower claim, even as a wildcard); then
// patterns with wildcards before exact ids; then fewer literal characters
// before more (`a--*` loses to `a--b-*`); then earlier in the file before
// later. Scalars: last wins. `mask` unions. `settle` and
// `network` merge field by field (settle.network lists concatenate; the
// override's network.rules are checked before the story's).

import type { StoryManifest, StoryOverride, StoryParams } from '../types.js';
import { StoriesSchema } from '../config/schema.js';
import { validate } from '../config/validate.js';
import { globToRegExp } from './url-pattern.js';
import { mergeSettle } from './settle-options.js';
import { checkRulePlaceholders, mergeNetwork } from './network-rules.js';
import { Trace } from './provenance.js';

const isWild = (glob: string) => /[*?]/.test(glob);

/** Validate `stories` where it is declared. `where` names the config (e.g.
 *  `project config`); each message names the glob and the key. */
export function checkStoryOverrides(
  raw: unknown,
  where = 'project config',
): Record<string, StoryOverride> {
  if (raw === undefined) return {};
  const stories = validate<Record<string, StoryOverride>>(StoriesSchema, raw, where);
  for (const [glob, o] of Object.entries(stories))
    checkRulePlaceholders(o.network?.rules, `${where}: stories '${glob}'`);
  return stories;
}

export interface CompiledOverride {
  glob: string;
  re: RegExp;
  spec: StoryOverride;
  /** Sort key: names a variant, exact id, literal length, file position. */
  rank: [number, number, number, number];
}

/** Compile validated overrides. Empty or absent gives an empty list. */
export function compileOverrides(
  stories: Record<string, StoryOverride> | undefined,
): CompiledOverride[] {
  return Object.entries(stories ?? {}).map(([glob, spec], i) => ({
    glob,
    re: globToRegExp(glob),
    spec,
    rank: [
      glob.includes('__') ? 1 : 0,
      isWild(glob) ? 0 : 1,
      glob.replace(/[*?]/g, '').length,
      i,
    ],
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
  /** Receives each matching glob's settings, in the order they are folded. */
  layer?: Trace,
): ResolvedOverride | undefined {
  const hits = compiled
    .filter(
      (c) =>
        c.re.test(capture.storyId) ||
        (capture.baseStoryId !== undefined && c.re.test(capture.baseStoryId)),
    )
    .sort(
      (a, b) =>
        a.rank[0] - b.rank[0] ||
        a.rank[1] - b.rank[1] ||
        a.rank[2] - b.rank[2] ||
        a.rank[3] - b.rank[3],
    );
  if (hits.length === 0) return undefined;
  let override: StoryOverride = {};
  for (const h of hits) {
    override = applyOverride(override, h.spec);
    layer?.put(h.spec, { layer: 'stories', detail: h.glob }, 'override');
  }
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
  const n = mergeNetwork(params.network, network);
  if (n) out.network = n;
  return out;
}

/** One capture with the matching override folded into `params` and noted on
 *  the manifest (`override` for live params to re-apply, `skippedBy` for the
 *  report). `params` is what the capture would have had without it. */
export function withOverride(
  story: StoryManifest,
  params: StoryParams,
  compiled: readonly CompiledOverride[],
  trace?: Trace,
): StoryManifest {
  const layer = trace && new Trace();
  const r = resolveOverride(compiled, story, layer);
  if (!r) return { ...story, params };
  if (trace && layer) {
    trace.apply(layer, 'override');
    trace.overrideLayer = layer;
    trace.matched = r.matched;
  }
  const next: StoryManifest = {
    ...story,
    params: applyOverride(params, r.override),
    override: r.override,
  };
  // Not when the story already skips itself: the config entry would not
  // change anything, and the handoff would send the user to remove it.
  if (r.skippedBy.length > 0 && params.skip !== true) next.skippedBy = r.skippedBy;
  return next;
}

/** Warnings for a config that validates but probably does not do what its
 *  author meant, checked against the final captures: a key that matches no
 *  story (a typo, a glob that cannot match), and `skip: false` on a variant
 *  key, which cannot un-skip a variant because a skipped story skips every
 *  variant. */
export function storyOverrideWarnings(
  stories: Record<string, StoryOverride> | undefined,
  captures: readonly { storyId: string; baseStoryId?: string }[],
): string[] {
  const out: string[] = [];
  for (const c of compileOverrides(stories)) {
    if (
      !captures.some(
        (s) =>
          c.re.test(s.storyId) ||
          (s.baseStoryId !== undefined && c.re.test(s.baseStoryId)),
      )
    )
      out.push(`stories['${c.glob}'] matched no story`);
    if (c.glob.includes('__') && c.spec.skip === false)
      out.push(
        `stories['${c.glob}'] sets skip: false on a variant key, which cannot un-skip it: ` +
          `a skipped story skips all its variants. Set skip: false on the story id instead`,
      );
  }
  return out;
}
