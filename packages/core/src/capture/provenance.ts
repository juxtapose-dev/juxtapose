// Where each capture setting came from (issue #179).
//
// The merge functions that decide a capture's settings (expandVariants,
// mergeLiveParams, applyOverride, the project and call layers in
// captureStory) take an optional Trace and, at each point where they fold one
// layer over another, say so: "these settings came from this source, with
// this merge rule". The trace never influences a value; with none passed the
// functions behave exactly as before. `jux config --explain` reads the
// values from the real merge result and the sources from the trace.
//
// Settings are flat strings: `delay`, `mask`, `network.external`,
// `settle.timeout`, `settle.network.ignore`. Each maps to the sources that
// contributed to its value: one for a scalar, several for a list that unions
// (`mask`, `settle.network.ignore`/`require`).

import type { StoryParams } from '../types.js';

/** The layers, lowest first. `default` is what no layer set. */
export type SourceLayer =
  'default' | 'project' | 'story' | 'stories' | 'variant' | 'live' | 'cli' | 'mcp';

export interface Source {
  layer: SourceLayer;
  /** The `stories` glob; the variant (and the variant extending it); empty otherwise. */
  detail?: string;
}

/** One `network.rules` entry and the layer that wrote it. */
export interface RuleSource {
  match: string;
  action: string;
  source: Source;
}

/** How a layer folds over what is already there; mirrors the real merges.
 *
 *  - replace: `Object.assign` (live params, the variant over live): a key in
 *    the layer replaces the key, and a `settle` or `network` replaces whole.
 *  - fold: `{...base, ...variant}` plus `mergeSettle`/`mergeNetwork`:
 *    `settle` and `network` merge field by field, `mask` replaces.
 *  - override: `applyOverride`, and stacking the project and call layers:
 *    `settle` and `network` merge field by field, `mask` unions.
 *
 *  `network` follows mergeNetwork in the last two: a string `external`
 *  replaces every per-type entry, an object merges per type, and the upper
 *  layer's rules go before the lower's. */
export type Mode = 'replace' | 'fold' | 'override';

const UNION_SETTINGS = new Set(['settle.network.ignore', 'settle.network.require']);

const same = (a: Source, b: Source) => a.layer === b.layer && a.detail === b.detail;

export class Trace {
  readonly sources = new Map<string, Source[]>();
  /** The variant's own layer (its `extends` chain folded), kept so live
   *  params can put it back over themselves. */
  variantLayer?: Trace;
  /** The `stories` overrides that matched, kept so live params can re-apply them. */
  overrideLayer?: Trace;
  /** `network.rules` in evaluation order (first match wins), each with its layer. */
  rules: RuleSource[] = [];
  /** The story's own `parameters.juxtapose` (without `variants`), before any variant or override. */
  storyParams?: StoryParams;
  private netSeen = false;
  private externalAll = false;
  /** Matching `stories` globs, least specific first. */
  matched: string[] = [];
  /** A variant's `extends` ancestors, farthest first. */
  chain: string[] = [];

  /** Record `values` as coming from `source`. */
  put(values: StoryParams | Record<string, unknown>, source: Source, mode: Mode): void {
    const layer = new Trace();
    for (const key of flatten(values)) layer.sources.set(key, [source]);
    const net = (values as StoryParams).network;
    if (net) {
      layer.netSeen = true;
      layer.externalAll = typeof net.external === 'string';
      layer.rules = (net.rules ?? []).map((r) => ({
        match: r.match,
        action: r.action,
        source,
      }));
    }
    this.apply(layer, mode);
  }

  /** Fold another trace over this one. */
  apply(layer: Trace, mode: Mode): void {
    const keys = [...layer.sources.keys()];
    if (mode === 'replace' && keys.some((k) => k.startsWith('settle.')))
      this.clear('settle.');
    if (layer.netSeen) {
      if (mode === 'replace') {
        this.clear('network.');
        this.rules = [];
        this.netSeen = false;
      } else if (layer.externalAll) this.clear('network.external.');
      // mergeNetwork returns the only side as it is, so a lone string stays one.
      this.externalAll = this.netSeen ? false : layer.externalAll;
      this.netSeen = true;
      this.rules =
        mode === 'replace' ? [...layer.rules] : [...layer.rules, ...this.rules];
    }
    for (const key of keys) {
      const incoming = layer.sources.get(key)!;
      const unions =
        (UNION_SETTINGS.has(key) && mode !== 'replace') ||
        (key === 'mask' && mode === 'override');
      const have = this.sources.get(key);
      if (unions && have) {
        const next = [...have];
        for (const s of incoming) if (!next.some((n) => same(n, s))) next.push(s);
        this.sources.set(key, next);
      } else this.sources.set(key, [...incoming]);
    }
  }

  clear(prefix: string): void {
    for (const key of [...this.sources.keys()])
      if (key.startsWith(prefix)) this.sources.delete(key);
  }

  clone(): Trace {
    const t = new Trace();
    for (const [k, v] of this.sources) t.sources.set(k, [...v]);
    if (this.variantLayer) t.variantLayer = this.variantLayer;
    if (this.overrideLayer) t.overrideLayer = this.overrideLayer;
    t.rules = [...this.rules];
    t.storyParams = this.storyParams;
    t.netSeen = this.netSeen;
    t.externalAll = this.externalAll;
    t.matched = [...this.matched];
    t.chain = [...this.chain];
    return t;
  }
}

/** The flat setting names a params-like object sets. `variants` is a
 *  declaration, not a setting. */
export function flatten(values: StoryParams | Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || key === 'variants') continue;
    if (key === 'settle' && typeof value === 'object' && value !== null) {
      const s = value as NonNullable<StoryParams['settle']>;
      if (s.timeout !== undefined) out.push('settle.timeout');
      if (s.ready !== undefined) out.push('settle.ready');
      if (s.network?.ignore !== undefined) out.push('settle.network.ignore');
      if (s.network?.require !== undefined) out.push('settle.network.require');
    } else if (key === 'network' && typeof value === 'object' && value !== null) {
      const external = (value as { external?: unknown }).external;
      if (typeof external === 'string') out.push('network.external.default');
      else if (typeof external === 'object' && external !== null)
        for (const [k, v] of Object.entries(external))
          if (v !== undefined) out.push(`network.external.${k}`);
    } else out.push(key);
  }
  return out;
}

/** One Trace per capture key. */
export class ProvenanceLog {
  private readonly traces = new Map<string, Trace>();
  for(captureKey: string): Trace {
    let t = this.traces.get(captureKey);
    if (!t) this.traces.set(captureKey, (t = new Trace()));
    return t;
  }
  get(captureKey: string): Trace | undefined {
    return this.traces.get(captureKey);
  }
}
