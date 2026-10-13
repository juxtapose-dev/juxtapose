// Per-story capture variants (spec 2026-10-13-variants-design.md).
//
// A variant is just another capture job: expansion happens once, after the
// platform enumerates, and everything downstream (pool, shuffle, warm browser,
// baselines, report) sees one StoryManifest per capture key. Pure on purpose:
// it does not care where a story's `variants` came from (index, meta.json, a
// url entry, or a preview extract), so a platform can change how it discovers
// them without touching this.

import { compareCodeUnits } from '../diff/structural/deltas.js';
import type { StoryManifest, StoryParams, VariantSpec } from '../types.js';
import { VariantConfigError } from './config-errors.js';
import { checkSettle, mergeSettle } from './settle-options.js';

/** Underscores are excluded so the `__` key separator can't occur in a name. */
export const VARIANT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const VARIANT_SEPARATOR = '__';

export { VariantConfigError } from './config-errors.js';

export const captureKey = (baseStoryId: string, variant: string): string =>
  `${baseStoryId}${VARIANT_SEPARATOR}${variant}`;

/** The id every platform call receives: the platform's own, never the key. */
export const platformStoryId = (story: { storyId: string; baseStoryId?: string }) =>
  story.baseStoryId ?? story.storyId;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Expand each story into its default capture plus one entry per variant,
 * sorted by capture key in code-unit order.
 *
 * Throws VariantConfigError on a bad name, a malformed spec, an unknown or
 * cyclic `extends`, or two captures that would share a key.
 */
export function expandVariants(
  stories: readonly StoryManifest[],
  projectVariants?: Record<string, VariantSpec | false>,
): StoryManifest[] {
  const project = checkDeclared(projectVariants, 'project config');
  const out: StoryManifest[] = [];

  for (const story of stories) {
    // `variants` is a declaration, not a capture setting, and `colorScheme`
    // is variant-only: the default capture is always light.
    const { variants: ownRaw, colorScheme: _ignored, ...baseParams } = story.params;
    checkSettle(baseParams.settle, `story '${story.storyId}'`);
    out.push({ ...story, params: baseParams });

    // A skipped story skips every variant: there is nothing to vary.
    if (baseParams.skip === true) continue;

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
      out.push({
        ...story,
        storyId: captureKey(story.storyId, name),
        baseStoryId: story.storyId,
        variant: name,
        variantParams: layer,
        // Base params, then the extends chain, then the variant itself.
        params: withSettle({ ...baseParams, ...layer }, baseParams.settle, layer.settle),
      });
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
  if (!isRecord(raw)) {
    throw new VariantConfigError(
      `${where}: 'variants' must be an object of named variants`,
    );
  }
  for (const [name, spec] of Object.entries(raw)) {
    if (!VARIANT_NAME.test(name)) {
      throw new VariantConfigError(
        `${where}: variant name '${name}' must match ${VARIANT_NAME.source} (lowercase letters, digits and dashes; no underscores)`,
      );
    }
    if (spec === false) continue;
    if (!isRecord(spec)) {
      throw new VariantConfigError(
        `${where}: variant '${name}' must be an object of capture settings, or false to opt out`,
      );
    }
    if ('skip' in spec) {
      throw new VariantConfigError(
        `${where}: variant '${name}' sets 'skip'; set the variant to false instead`,
      );
    }
    const scheme = spec['colorScheme'];
    if (scheme !== undefined && scheme !== 'light' && scheme !== 'dark') {
      throw new VariantConfigError(
        `${where}: variant '${name}' colorScheme must be 'light' or 'dark'`,
      );
    }
    checkSettle(spec['settle'], `${where}: variant '${name}'`);
    const ext = spec['extends'];
    if (ext !== undefined && typeof ext !== 'string') {
      throw new VariantConfigError(
        `${where}: variant '${name}' extends must be a variant name`,
      );
    }
  }
  return raw as Record<string, VariantSpec | false>;
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
    Object.assign(layer, spec);
    if (settle) layer.settle = settle;
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

/**
 * Merge live params (read from the rendered preview) for one capture.
 *
 * Live params override the manifest — the preview is the story's own
 * declaration, the index a lossy projection of it — but they merge UNDER a
 * variant's layer: a story's own live `viewport` must not undo the mobile
 * variant's. `variants` and `colorScheme` in live params are declarations,
 * not settings for this capture, so they are dropped.
 */
export function mergeLiveParams(
  story: Pick<StoryManifest, 'params' | 'variantParams'>,
  live: StoryParams | undefined,
): StoryParams {
  const params: StoryParams = { ...story.params };
  if (!live) return params;
  const { variants: _v, colorScheme: _c, ...settings } = live;
  Object.assign(params, settings, story.variantParams ?? {});
  const variantSettle = story.variantParams?.settle;
  return variantSettle
    ? withSettle(params, settings.settle ?? story.params.settle, variantSettle)
    : params;
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
