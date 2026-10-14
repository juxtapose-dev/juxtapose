// Per-story capture variants (spec 2026-10-13-variants-design.md).
//
// A variant is just another capture job: expansion happens once, after the
// platform enumerates, and everything downstream (pool, shuffle, warm browser,
// baselines, report) sees one StoryManifest per capture key. Pure on purpose:
// it does not care where a story's `variants` came from (index, meta.json, a
// url entry, or a preview extract), so a platform can change how it discovers
// them without touching this.

import { checkNetwork } from './network-policy.js';
import { checkRulePlaceholders, mergeNetwork } from './network-rules.js';
import { compareCodeUnits } from '../diff/structural/deltas.js';
import type { StoryManifest, StoryOverride, StoryParams, VariantSpec } from '../types.js';
import { VariantsRuntimeSchema } from '../config/schema.js';
import { validate } from '../config/validate.js';
import { VariantConfigError } from './config-errors.js';
import { checkSettle, mergeSettle } from './settle-options.js';
import {
  applyOverride,
  checkStoryOverrides,
  compileOverrides,
  withOverride,
} from './story-overrides.js';

export { VARIANT_NAME } from '../config/schema.js';

export const VARIANT_SEPARATOR = '__';

export { VariantConfigError } from './config-errors.js';

export const captureKey = (baseStoryId: string, variant: string): string =>
  `${baseStoryId}${VARIANT_SEPARATOR}${variant}`;

/** The id every platform call receives: the platform's own, never the key. */
export const platformStoryId = (story: { storyId: string; baseStoryId?: string }) =>
  story.baseStoryId ?? story.storyId;

/**
 * Expand each story into its default capture plus one entry per variant,
 * sorted by capture key in code-unit order.
 *
 * `projectStories` is the config's per-story overrides: folded over each
 * capture's params last, so they beat the story's and the variant's own.
 *
 * Throws VariantConfigError on a bad name, a malformed spec, an unknown or
 * cyclic `extends`, a bad override, or two captures that would share a key.
 */
export function expandVariants(
  stories: readonly StoryManifest[],
  projectVariants?: Record<string, VariantSpec | false>,
  projectStories?: Record<string, StoryOverride>,
): StoryManifest[] {
  const project = checkDeclared(projectVariants, 'project config');
  const overrides = compileOverrides(checkStoryOverrides(projectStories));
  const out: StoryManifest[] = [];

  for (const story of stories) {
    // `variants` is a declaration, not a capture setting, and `colorScheme`
    // is variant-only: the default capture is always light.
    const { variants: ownRaw, colorScheme: _ignored, ...baseParams } = story.params;
    checkSettle(baseParams.settle, `story '${story.storyId}'`);
    checkNetwork(baseParams.network, `story '${story.storyId}'`);
    const base = withOverride(story, baseParams, overrides);
    out.push(base);

    // A skipped story skips every variant: there is nothing to vary.
    if (base.params.skip === true) continue;

    const own = checkDeclared(ownRaw, `story '${story.storyId}'`);
    // Story wins by name; `false` drops the name entirely.
    const merged = new Map<string, VariantSpec>();
    for (const [name, spec] of Object.entries(project)) {
      if (spec !== false) merged.set(name, spec);
    }
    for (const [name, spec] of Object.entries(own)) {
      if (spec === false) merged.delete(name);
      else merged.set(name, spec);
    }

    for (const name of [...merged.keys()].sort(compareCodeUnits)) {
      const layer = resolveChain(story.storyId, name, merged);
      out.push(
        withOverride(
          {
            ...story,
            storyId: captureKey(story.storyId, name),
            baseStoryId: story.storyId,
            variant: name,
            variantParams: layer,
          },
          // Base params, then the extends chain, then the variant itself;
          // the config override goes over all three.
          withNetwork(
            withSettle({ ...baseParams, ...layer }, baseParams.settle, layer.settle),
            baseParams.network,
            layer.network,
          ),
          overrides,
        ),
      );
    }
  }

  out.sort((a, b) => compareCodeUnits(a.storyId, b.storyId));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    if (prev.storyId === cur.storyId) {
      throw new VariantConfigError(
        `capture key '${cur.storyId}' is produced by both ${describe(prev)} and ${describe(cur)}; rename the variant or the story`,
      );
    }
  }
  return out;
}

const describe = (s: StoryManifest): string =>
  s.variant === undefined
    ? `story '${s.storyId}'`
    : `story '${s.baseStoryId}' variant '${s.variant}'`;

/** Validate names and shapes where they are declared, before any merge, so
 *  the error names the place the user has to edit. */
function checkDeclared(raw: unknown, where: string): Record<string, VariantSpec | false> {
  if (raw === undefined) return {};
  const variants = validate<Record<string, VariantSpec | false>>(
    VariantsRuntimeSchema,
    raw,
    where,
  );
  for (const [name, v] of Object.entries(variants))
    if (v) checkRulePlaceholders(v.network?.rules, `${where}: variant '${name}'`);
  return variants;
}

/** The variant's own layer: its extends chain (farthest ancestor first),
 *  then the variant itself, with `extends` removed. */
function resolveChain(
  storyId: string,
  name: string,
  merged: ReadonlyMap<string, VariantSpec>,
): Omit<VariantSpec, 'extends'> {
  const chain: VariantSpec[] = [];
  const seen: string[] = [];
  let cur: string | undefined = name;
  while (cur !== undefined) {
    if (seen.includes(cur)) {
      throw new VariantConfigError(
        `story '${storyId}' variant '${name}': extends cycle ${[...seen, cur].join(' -> ')}`,
      );
    }
    seen.push(cur);
    const spec = merged.get(cur);
    if (!spec) {
      // Only reachable for an ancestor: `name` itself came from `merged`.
      throw new VariantConfigError(
        `story '${storyId}' variant '${seen[seen.length - 2]}' extends unknown variant '${cur}'`,
      );
    }
    chain.unshift(spec);
    cur = spec.extends;
  }
  const layer: VariantSpec = {};
  for (const spec of chain) {
    const settle = mergeSettle(layer.settle, spec.settle);
    const network = mergeNetwork(layer.network, spec.network);
    Object.assign(layer, spec);
    if (settle) layer.settle = settle;
    if (network) layer.network = network;
  }
  delete layer.extends;
  return layer;
}

/** `params` with `settle` merged field by field rather than replaced, so a
 *  variant's `settle.timeout` keeps the story's `settle.network`. Untouched
 *  (no `settle` key) when neither side sets one. */
function withSettle<T extends StoryParams>(
  params: T,
  under: StoryParams['settle'],
  over: StoryParams['settle'],
): T {
  const settle = mergeSettle(under, over);
  return settle ? { ...params, settle } : params;
}

/** `params` with `network` merged (type map field by field, the over layer's
 *  rules first) rather than replaced. Untouched when neither side sets one. */
function withNetwork<T extends StoryParams>(
  params: T,
  under: StoryParams['network'],
  over: StoryParams['network'],
): T {
  const network = mergeNetwork(under, over);
  return network ? { ...params, network } : params;
}

/**
 * Merge live params (read from the rendered preview) for one capture.
 *
 * Live params override the manifest — the preview is the story's own
 * declaration, the index a lossy projection of it — but they merge UNDER a
 * variant's layer: a story's own live `viewport` must not undo the mobile
 * variant's. A config override goes over both: live params are the story's
 * own word, and the override exists to correct it. `variants` and `colorScheme` in live params are declarations,
 * not settings for this capture, so they are dropped.
 */
export function mergeLiveParams(
  story: Pick<StoryManifest, 'params' | 'variantParams' | 'override'>,
  live: StoryParams | undefined,
): StoryParams {
  const params: StoryParams = { ...story.params };
  if (!live) return params;
  const { variants: _v, colorScheme: _c, ...settings } = live;
  Object.assign(params, settings, story.variantParams ?? {});
  const variantSettle = story.variantParams?.settle;
  const variantNetwork = story.variantParams?.network;
  const settled = variantSettle
    ? withSettle(params, settings.settle ?? story.params.settle, variantSettle)
    : params;
  const layered = variantNetwork
    ? withNetwork(settled, settings.network ?? story.params.network, variantNetwork)
    : settled;
  return applyOverride(layered, story.override);
}

/**
 * Pick items by story id: a base id selects the story and every variant of
 * it, a capture key selects exactly that capture. Ids that match nothing are
 * returned so the caller can report them.
 */
export function selectByStoryId<T extends { storyId: string; baseStoryId?: string }>(
  items: readonly T[],
  ids: readonly string[],
): { selected: T[]; unknown: string[] } {
  const wanted = new Set(ids);
  const hit = new Set<string>();
  const selected = items.filter((s) => {
    if (wanted.has(s.storyId)) {
      hit.add(s.storyId);
      return true;
    }
    if (s.baseStoryId !== undefined && wanted.has(s.baseStoryId)) {
      hit.add(s.baseStoryId);
      return true;
    }
    return false;
  });
  return { selected, unknown: ids.filter((id) => !hit.has(id)) };
}

/** Structural equality for JSON-shaped values: key order doesn't matter,
 *  array order does. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  return (
    ka.length === Object.keys(rb).length &&
    ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]))
  );
}
