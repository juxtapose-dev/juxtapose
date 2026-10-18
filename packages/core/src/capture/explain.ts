import { resolveRenderer } from './renderer.js';
// `jux config --explain <storyId>` (issue #179): the settings one capture
// would use, and which layer each came from.
//
// Values come from the real resolution (expandVariants, mergeLiveParams,
// layerScalars, resolveSettle, resolveExternal, resolveThreshold); sources
// come from the Trace those functions fill in. Nothing here decides a
// precedence, it only stacks the project and call layers around the trace in
// the order captureStory does.

import type { Page } from '../browser/page.js';
import { resolveDevices } from '../browser/devices.js';
import { resolveCaptureDevice, UnknownDeviceError } from './device.js';
import type { Orientation, Viewport } from '../browser/types.js';
import { resolveMinDiffPercent, resolveThreshold } from '../diff/diff.js';
import type { Platform } from '../platform.js';
import type { RecheckMode } from '../config/schema.js';
import { DEFAULT_VIEWPORT, effectiveRecheck } from '../run/run.js';
import type { ProjectConfig, StoryManifest, StoryParams } from '../types.js';
import { externalTypes, liveNetworkDiffers, resolveNetwork } from './network-rules.js';
import { layerCapture, layerFreeze, layerNetwork, type CaptureLayers } from './layers.js';
import { resolveFreeze } from './freeze.js';
import { Trace, flatten, type ProvenanceLog, type Source } from './provenance.js';
import { resolveSettle, type SettleLayer } from './settle-options.js';
import { deepEqual, mergeLiveParams, platformStoryId } from './variants.js';

export type { Source } from './provenance.js';

export interface ExplainedSetting {
  setting: string;
  value: unknown;
  /** The layer that set it; several for a list that unions across layers. */
  source: Source[];
}

export interface ExplainedRule {
  match: string;
  action: string;
  source: Source;
}

export interface Explanation {
  schema: 'juxtapose.explain/v1';
  /** The capture key explained. */
  storyId: string;
  baseStoryId?: string;
  variant?: string;
  /** The variants this one extends, farthest first. */
  extends?: string[];
  /** On a story that has variants: their capture keys. */
  variants?: string[];
  /** The capture is not taken (a story, live or `stories` skip). */
  skipped: boolean;
  /** What matched this capture. */
  matched: {
    stories: string[];
    /** The effective `network.rules` in evaluation order (first match wins,
     *  higher layers first), each with the layer that wrote it. */
    networkRules: ExplainedRule[];
  };
  settings: ExplainedSetting[];
  /** Things that look like they should apply and do not. */
  notes: string[];
}

export interface ExplainOptions {
  config: ProjectConfig;
  /** The per-call layer: CLI flags or MCP arguments. */
  call?: SettleLayer;
  /** Which caller supplied `call`: the CLI's flags (default) or MCP arguments. */
  callLayer?: 'cli' | 'mcp';
  /** Params read from the rendered preview, when the platform has them. */
  live?: StoryParams;
  /** The per-call recheck mode (`--recheck`, the MCP argument). */
  recheck?: RecheckMode;
}

const ALIASES: Record<string, true> = { mobile: true, tablet: true, desktop: true };

const PROJECT: Source = { layer: 'project' };
const DEFAULT: Source[] = [{ layer: 'default' }];

/** Listed even when no layer sets them. */
const ALWAYS = [
  'skip',
  'viewport',
  'settle.timeout',
  'settle.ready',
  'network.external.default',
  'freeze.clock',
  'freeze.random',
  'freeze.images',
  'threshold',
  'minDiffPercent',
  'recheck',
  'renderer.shared',
  'renderer.clearResourceCache',
];

/** Read by captureStory (or the diff) before live params exist, so live
 *  values for them are ignored. */
const PRE_PARAMS = [
  'threshold',
  'minDiffPercent',
  'captureTimeout',
  'animations',
  'captureAfterPlay',
];

/** The order settings print in; anything else follows alphabetically. */
const ORDER = [
  ...ALWAYS.slice(0, ALWAYS.indexOf('network.external.default') + 1),
  'network.external.images',
  'network.external.frames',
  'network.external.media',
  ...ALWAYS.slice(ALWAYS.indexOf('network.external.default') + 1),
  'colorScheme',
  'animations',
  'captureAfterPlay',
  'captureTimeout',
  'mask',
  'waitForSelector',
  'delay',
  'settle.network.ignore',
  'settle.network.require',
];

function projectLayer(c: ProjectConfig): SettleLayer & StoryParams {
  return {
    ...(c.renderer ? { renderer: c.renderer } : {}),
    ...(c.settle ? { settle: c.settle } : {}),
    ...(c.network ? { network: c.network } : {}),
    ...(c.freeze ? { freeze: c.freeze } : {}),
    ...(c.waitForSelector !== undefined ? { waitForSelector: c.waitForSelector } : {}),
    ...(c.delay !== undefined ? { delay: c.delay } : {}),
    ...(c.viewport ? { viewport: c.viewport } : {}),
    ...(c.device !== undefined ? { device: c.device } : {}),
    ...(c.orientation !== undefined ? { orientation: c.orientation } : {}),
    ...(c.threshold !== undefined ? { threshold: c.threshold } : {}),
    ...(c.minDiffPercent !== undefined ? { minDiffPercent: c.minDiffPercent } : {}),
  };
}

/** The value of a flat setting name in a params-like object. */
function valueOf(params: StoryParams, setting: string): unknown {
  let cur: unknown = params;
  for (const part of setting.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** What the capture will be sized and emulated as, from the resolver
 *  captureStory uses. `label` is the device as one line (its name, the
 *  built-in it aliases, its size and orientation), present when a layer sets
 *  a device; `orientation` when a device or an orientation is set. */
function describeDevice(
  params: StoryParams,
  config: ProjectConfig,
): { viewport: Viewport; device?: string; orientation?: Orientation; label?: string } {
  const registry = resolveDevices(config.devices);
  try {
    const r = resolveCaptureDevice(
      params,
      {
        devices: registry,
        ...(config.device !== undefined ? { defaultDevice: config.device } : {}),
        ...(config.orientation !== undefined
          ? { defaultOrientation: config.orientation }
          : {}),
      },
      config.viewport ?? DEFAULT_VIEWPORT,
    );
    const orientation = r.emulation?.orientation;
    const view = {
      viewport: r.viewport,
      ...(orientation !== undefined ? { orientation } : {}),
    };
    if (r.device === undefined) return view;
    const descriptor = registry.get(r.device);
    // `mobile` shows the preset it points at: the first key with the same
    // descriptor that is not itself an alias.
    const target = [...registry.entries()].find(
      ([k, d]) => k !== r.device && d === descriptor && !(k in ALIASES),
    )?.[0];
    const shape = `${r.viewport.width}x${r.viewport.height} ${orientation}`;
    return {
      ...view,
      device: r.device,
      label: `${r.device} (${target !== undefined ? `${target}, ` : ''}${shape})`,
    };
  } catch (e) {
    if (e instanceof UnknownDeviceError) {
      const device = params.device ?? config.device;
      return {
        viewport: DEFAULT_VIEWPORT,
        device: device!,
        label: `${device} (unknown)`,
      };
    }
    throw e;
  }
}

/** The captures of one story: the default one first, then its variants. */
export function findCaptures(
  captures: readonly StoryManifest[],
  id: string,
): { capture: StoryManifest; variants: string[] } | undefined {
  const capture = captures.find((c) => c.storyId === id);
  if (!capture) return undefined;
  const variants =
    capture.variant === undefined
      ? captures.filter((c) => c.baseStoryId === id).map((c) => c.storyId)
      : [];
  return { capture, variants };
}

/** Reads a story's live params from the rendered preview, as a capture does
 *  before its settle: show the story, let the platform settle, ask. */
export function liveReader(
  platform: Platform,
  page: () => Promise<Page>,
  baseUrl: string,
  timeoutMs = 2000,
): ((capture: StoryManifest) => Promise<StoryParams | undefined>) | undefined {
  const read = platform.readLiveParams?.bind(platform);
  if (!read) return undefined;
  return async (capture) => {
    const p = await page();
    const id = platformStoryId(capture);
    await platform.showStory(p, id, baseUrl);
    await platform.settle(p, {
      story: id === capture.storyId ? capture : { ...capture, storyId: id },
      params: { ...capture.params },
      timeoutMs,
    });
    return read(p, id);
  };
}

export function explainCapture(
  capture: StoryManifest,
  log: ProvenanceLog,
  opts: ExplainOptions,
  variants: string[] = [],
): Explanation {
  const { config, call, live } = opts;
  const callSource: Source = { layer: opts.callLayer ?? 'cli' };
  const project = projectLayer(config);
  const layers: CaptureLayers = { project, ...(call ? { call } : {}) };
  const expansion = log.get(capture.storyId) ?? new Trace();

  // The sources, stacked in the order layers.ts stacks the values: the
  // project under the capture's own layers, the call over both. `pre` is
  // before live params (what captureStory reads before it renders), `post`
  // after.
  const stack = (own: Trace): Trace => {
    const t = new Trace();
    t.put(project, PROJECT, 'override');
    t.apply(own, 'override');
    if (call) t.put(call, callSource, 'override');
    return t;
  };
  const pre = stack(expansion);
  const liveTrace = expansion.clone();
  const merged: StoryParams = { ...capture.params };
  Object.assign(merged, mergeLiveParams(capture, live));
  // A platform whose discovery reads the same parameters (Storybook) reports
  // them again live. A key live repeats from the story's own parameters
  // decided nothing, so the trace leaves it with the layer that first set it.
  if (live) {
    const own = expansion.storyParams ?? capture.params;
    const news = Object.fromEntries(
      Object.entries(live).filter(([k, v]) => !deepEqual(v, own[k as keyof StoryParams])),
    );
    mergeLiveParams(capture, news, liveTrace);
  }
  const post = stack(liveTrace);

  const params: StoryParams = { ...merged };
  const layered = layerCapture(layers, params);
  Object.assign(params, layered.scalars);
  const resolved = resolveSettle(layered.settle);
  const view: StoryParams = {
    ...params,
    ...(layered.settle ? { settle: layered.settle } : {}),
  };

  // Before live params exist, so live cannot change them.
  const netParams = layerNetwork(layers, capture.params);
  const policy = resolveNetwork(netParams);
  const types = externalTypes(netParams?.external);
  // Also before navigation; `images` is a launch setting, the project's only.
  const freeze = resolveFreeze({
    ...layerFreeze(layers, capture.params),
    ...(config.freeze?.images !== undefined ? { images: config.freeze.images } : {}),
  });

  const optedOut =
    capture.variant !== undefined && live?.variants?.[capture.variant] === false;
  const skipped = optedOut || params.skip === true;

  const names = new Set([
    ...ALWAYS,
    ...flatten(view).filter((n) => !n.startsWith('network.') && !n.startsWith('freeze.')),
    ...flatten(project).filter(
      (n) => !n.startsWith('network.') && !n.startsWith('freeze.'),
    ),
    ...flatten(capture.params).filter((n) => PRE_PARAMS.includes(n)),
    ...Object.keys(types).map((k) => `network.external.${k}`),
  ]);

  const deviceView = describeDevice(params, config);
  const fromPre = new Set(PRE_PARAMS);
  const settings: ExplainedSetting[] = [];
  const preValues = new Map<string, unknown>();
  for (const setting of names) {
    let value: unknown;
    let source: Source[] | undefined;
    switch (setting) {
      case 'skip':
        value = skipped;
        if (optedOut)
          source = [{ layer: 'live', detail: `variants.${capture.variant}: false` }];
        break;
      case 'viewport':
        value = deviceView.viewport;
        // A device-sized viewport came from whoever set the device; a story,
        // variant or live viewport overrides it and keeps its own source.
        if (deviceView.device !== undefined && params.viewport === undefined)
          source = post.sources.get('device');
        break;
      case 'device':
        value = deviceView.label;
        break;
      case 'orientation':
        // The resolved one: a story viewport's shape wins over an orientation.
        value = deviceView.orientation;
        break;
      case 'settle.timeout':
        value = resolved.timeoutMs;
        break;
      case 'settle.ready':
        value = resolved.ready;
        break;
      case 'network.external.default':
        value = policy.default;
        break;
      case 'network.external.images':
      case 'network.external.frames':
      case 'network.external.media':
        value = policy[setting.slice('network.external.'.length) as 'images'];
        break;
      case 'freeze.clock':
        value = freeze.clockMs === null ? false : new Date(freeze.clockMs).toISOString();
        break;
      case 'freeze.random':
        value = freeze.random;
        break;
      case 'freeze.images':
        value = freeze.images;
        // A launch setting: only the project config sets it.
        source = config.freeze?.images !== undefined ? [PROJECT] : DEFAULT;
        break;
      case 'threshold':
        value = resolveThreshold(capture.params, config);
        break;
      case 'minDiffPercent':
        value = resolveMinDiffPercent(capture.params, config);
        break;
      case 'renderer.shared':
      case 'renderer.clearResourceCache':
        value = resolveRenderer(config, merged.renderer)[
          setting === 'renderer.shared' ? 'shared' : 'clearResourceCache'
        ];
        if (
          !post.sources.has(setting) &&
          setting === 'renderer.shared' &&
          config.freshRenderer !== undefined
        )
          source = [PROJECT];
        break;
      case 'recheck':
        // A run-wide setting: no story or variant layer, so its source is
        // the call, the project or the default.
        value = effectiveRecheck(opts.recheck, config);
        source =
          opts.recheck !== undefined
            ? [callSource]
            : config.recheck !== undefined
              ? [PROJECT]
              : DEFAULT;
        break;
      default:
        value = fromPre.has(setting)
          ? (valueOf(capture.params, setting) ?? valueOf(project, setting))
          : valueOf(view, setting);
    }
    if (value === undefined) continue;
    const beforeNav =
      fromPre.has(setting) ||
      setting.startsWith('network.') ||
      setting.startsWith('freeze.');
    if (beforeNav) preValues.set(setting, value);
    const trace = beforeNav ? pre : post;
    settings.push({
      setting,
      value,
      source: source ?? trace.sources.get(setting) ?? DEFAULT,
    });
  }
  const rank = (s: string) => {
    const i = ORDER.indexOf(s);
    return i < 0 ? ORDER.length : i;
  };
  settings.sort(
    (a, b) => rank(a.setting) - rank(b.setting) || (a.setting < b.setting ? -1 : 1),
  );

  const notes: string[] = [];
  if (
    live?.network !== undefined &&
    call?.network === undefined &&
    liveNetworkDiffers(policy, project.network, merged.network)
  )
    notes.push(
      `the story's live parameters set network ${JSON.stringify(live.network)}, which is read before navigation and was ignored. Declare it in the project config or the command.`,
    );
  const liveFreeze =
    live?.freeze !== undefined ? resolveFreeze(layerFreeze(layers, merged)) : null;
  if (
    liveFreeze &&
    call?.freeze === undefined &&
    (liveFreeze.clockMs !== freeze.clockMs || liveFreeze.random !== freeze.random)
  )
    notes.push(
      `the story's live parameters set freeze ${JSON.stringify(live?.freeze)}, which is read before navigation and was ignored. Declare it in the story's parameters, the project config or a stories override.`,
    );
  for (const k of PRE_PARAMS) {
    const v = live?.[k as keyof StoryParams];
    if (v === undefined || deepEqual(v, preValues.get(k))) continue;
    notes.push(
      k === 'threshold' || k === 'minDiffPercent'
        ? `the story's live parameters set ${k} ${JSON.stringify(v)}, which the diff does not read from live parameters and was ignored. Declare it in the story's parameters, the project config or a stories override.`
        : `the story's live parameters set ${k} ${JSON.stringify(v)}, which is read before live parameters are available and was ignored. Declare it in the story's parameters, the project config or a stories override.`,
    );
  }

  const rules = netParams?.rules ?? [];
  const networkRules: ExplainedRule[] = rules.map((r, i) => ({
    match: r.match,
    action: r.action,
    source: pre.rules[i]?.source ?? DEFAULT[0]!,
  }));

  return {
    schema: 'juxtapose.explain/v1',
    storyId: capture.storyId,
    ...(capture.baseStoryId !== undefined ? { baseStoryId: capture.baseStoryId } : {}),
    ...(capture.variant !== undefined ? { variant: capture.variant } : {}),
    ...(expansion.chain.length > 0 ? { extends: expansion.chain } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    skipped,
    matched: { stories: expansion.matched, networkRules },
    settings,
    notes,
  };
}
