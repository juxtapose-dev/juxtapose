// `jux mcp` — a Model Context Protocol server on stdio, for coding agents that
// have no shell or that pay a browser launch per `jux` call.
//
// Most tools call the same function as `jux <command> --json`. The run tool
// returns a bounded agent overview by default; report retrieves its saved
// full JSON or one result without capturing again. What MCP adds is the session: one browser
// acquired on first use and lent to every snap and run until stdin closes,
// which is the per-call launch cost an agent loop otherwise pays each turn.
// Calls that touch different snaps run in parallel on that browser;
// scheduler.ts decides which calls may overlap.
//
// Hand-rolled JSON-RPC 2.0 over newline-delimited stdio (MCP 2025-06-18),
// like the dependency-free CDP driver: the surface is five methods.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  acquireBrowser,
  isElementQuery,
  checkElementProperties,
  ELEMENT_QUERY_FIELDS,
  freezeImages,
  checkNetwork,
  checkSettle,
  configWarnings,
  MAX_CROPS,
  MAX_SNAP_SLOTS,
  NetworkSchema,
  parseRunReport,
  RECHECK_MODES,
  SettleSchema,
  type Browser,
} from '@juxtapose/core';
import type { RecheckFlags } from '../recheck-flags.js';
import type { SettleFlags } from '../settle-flags.js';
import { EXIT } from '../exit-codes.js';
import { isRecord } from '../guards.js';
import { loadConfig } from '../context.js';
import { captureIo, type Session } from '../io.js';
import { latestRunDir } from '../run-dir.js';
import { SavedElementCache } from './saved-element.js';
import {
  EXCLUSIVE,
  Scheduler,
  type Lock,
  type LockKey,
  type LockSet,
} from '../scheduler.js';
import { snapName } from '../snap-name.js';
import { MAX_VIEWPORT_SIDE } from './snap.js';
import { agentRunSummary, SavedReportCache, savedRuns } from './agent-run-report.js';
import type { ReferenceChangeResult, ReferenceResult } from './reference.js';
import { ReferenceLayoutCache } from './reference-layout.js';

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
export { MAX_SNAP_SLOTS };

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

/**
 * A config schema from @juxtapose/core as a tool argument: the shape is the
 * config's, so an agent writes the same object it would put in
 * juxtapose.config.json and the shapes cannot drift. The wording is the
 * tool's own, shorter than the config's: descriptions are sent on every agent
 * turn. `descriptions` is keyed by property path ('' for the argument itself).
 */
function toolArg(
  schema: object,
  descriptions: Record<string, string>,
): Record<string, unknown> {
  // `format` names jux's own checks (URL patterns), which a client's
  // validator doesn't know and may refuse; the server checks them anyway.
  const out = JSON.parse(JSON.stringify(schema), (k: string, v: unknown) =>
    k === 'description' || k === 'format' ? undefined : v,
  ) as Record<string, unknown>;
  for (const [at, text] of Object.entries(descriptions)) {
    let node = out;
    for (const seg of at ? at.split('.') : [])
      node = (node['properties'] as Record<string, Record<string, unknown>>)[seg]!;
    node['description'] = text;
  }
  return out;
}

// Over the story's and the project's.
const SETTLE = toolArg(SettleSchema, {
  '': 'Settle options for this call. A capture at the cap is flagged settle-timeout, one whose wait could not run settle-fallback; `settle.pending` says what or why',
  timeout: 'Cap on the wait, ms (default 1500)',
  ready: 'Wait for window.__juxtapose.ready()',
  'network.ignore':
    'URL patterns never waited for, e.g. "/api/poll" or "type:Fetch **/ws*"',
  'network.require': 'URL patterns that must complete before capture',
});

const NETWORK = toolArg(NetworkSchema, {
  '': 'Request policy for this call. Blocking or replacing third-party requests keeps a random image or an embed from changing or stalling the capture',
  external:
    "'allow' (default) or 'block' third-party requests, or { default, images, frames, media } with 'placeholder' for images and frames",
  rules:
    'Checked first, in order, first match wins: [{ match: URL glob or type:<ResourceType>, action: allow|block|placeholder }]',
});

const RECHECK = {
  type: 'string',
  enum: [...RECHECK_MODES],
  description:
    'Which stories get a second capture so approve can tell a flake from a stable capture, over the config\'s `recheck`. "changed" (default): new and failing. "new": new only. "off": none (fastest; approve takes the confirming capture; no `flake` analysis).',
};

export const TOOLS: Tool[] = [
  {
    name: 'snap',
    description:
      'URL workflow: capture pixels + structure under a name. If no before snap exists, snap before editing; snap after editing under another name, then diff. Pass url+as for one page, or urls+asPrefix for several. For Storybook/Ladle use run instead.',
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
        device: {
          type: 'string',
          description:
            'Device preset to emulate: its size, touch and user agent. A key (iphone-15, pixel-8, ipad), an alias (mobile, tablet, desktop) or a device from the project config. A viewport overrides only the size.',
        },
        orientation: {
          type: 'string',
          enum: ['portrait', 'landscape'],
          description:
            "Rotate the viewport. Defaults to the device's listed shape, taller than wide is portrait.",
        },
        fullPage: {
          type: 'boolean',
          description:
            'Capture the full document without changing the layout viewport; default false',
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
      'Compare two snaps. Returns juxtapose.verdict/v1 (prefix: juxtapose.verdict-set/v1); differences are a result, not an error. Set crops when the text evidence is insufficient to judge appearance, including when `explained` is "full": it adds juxtapose.crops/v1 and baseline|current PNG strips.',
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
    name: 'list',
    description:
      'List available story IDs, titles and variant capture keys. Optional ID globs filter the selection. No screenshots or run report; live parameter discovery may open the preview. Returns juxtapose.selection/v1.',
    inputSchema: {
      type: 'object',
      properties: {
        stories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact IDs or ID globs; unmatched selectors fail',
        },
      },
    },
  },
  {
    name: 'run',
    description:
      'Capture affected stories and variants together after an edit (Storybook/Ladle or configured URLs). One call returns the baseline verdict, target hint, and optional compareTo checkpoint change; do not repeat them with report or reference. changesFromApproved measures approved→current, not design-target error. The summary includes selected control measurements when they add missing detail. A subset pass does not verify omitted targets. Request report=full only for missing per-state detail.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Capture every story' },
        compareTo: {
          type: 'string',
          description:
            'Saved run ID or "previous" (resolved before capture). Append the saved pixel/structure change; off by default.',
        },
        progress: {
          type: 'boolean',
          description:
            'Opt-in target pixel trend and bestRun among the newest 20 saved runs; off by default. Record bestRun as a checkpoint. To roll back, restore its source, not the baselines.',
        },
        feedback: {
          type: 'string',
          enum: ['target', 'none'],
          description:
            'Design-target hint after capture (default), or none to skip target analysis; compareTo works with either',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Return resolved capture selection without screenshots or a run report; discovery may open the preview',
        },
        since: { type: 'string', description: 'Git ref; trace changes since it' },
        stories: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Story IDs or ID globs (*, **, ?): a base story match includes its variants, a capture key (id__variant) selects just that capture. Unmatched selectors fail.',
        },
        settle: SETTLE,
        network: NETWORK,
        recheck: RECHECK,
        report: {
          type: 'string',
          enum: ['summary', 'full'],
          description:
            'Response detail (default summary); full returns the complete RunReport',
        },
      },
    },
  },
  {
    name: 'report',
    description:
      'Read a saved Storybook/Ladle run without capture. Default: bounded summary; story: one full capture result, including available controlGeometry (measured approved/current control sizes, not CSS causes); detail=full: complete RunReport; detail=runs: saved run IDs, newest first. Request one story when wrapper resize facts leave control dimensions unclear. With story and element, inspect unique saved current-element rect/styles; optional properties narrows the captured values. Use only when current computed values are unclear. runId selects an older saved run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Saved run ID (default latest)' },
        story: { type: 'string', description: 'Exact capture key for one result' },
        detail: { type: 'string', enum: ['summary', 'full', 'runs'] },
        element: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: Object.fromEntries(
            ELEMENT_QUERY_FIELDS.map((key) => [key, { type: 'string' }]),
          ),
          description:
            'With story: exact saved current-element fields (AND); ambiguous or truncated snapshots abstain. Not a live CSS selector.',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 12,
          description:
            'With element: captured computed properties to return; default typography and vertical margins. No live query.',
        },
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
    name: 'reference',
    description:
      'Read saved image evidence for a remaining question, without recapture. Default compares the latest capture with the design target. compare=previous compares two saved runs (fromRun, and toRun defaulting to the latest) for every capture both saved: changed pixels plus observed structural changes (property old→new, resizes). Use it against a checkpoint run ID to see what later edits changed; it does not measure progress toward the target. Set detail=layout with name for focused target paint measurements; detail=json returns regions and the full ledger, or region for one paired PNG crop. A passing target run hint needs no reference call. Use local image analysis only for facts the saved evidence lacks.',
    inputSchema: {
      type: 'object',
      properties: {
        compare: {
          type: 'string',
          enum: ['target', 'previous'],
          description: 'Design target (default) or a prior saved capture',
        },
        fromRun: {
          type: 'string',
          description: 'Required with compare=previous; exact earlier run ID',
        },
        toRun: {
          type: 'string',
          description: 'With compare=previous: the later run ID (default latest)',
        },
        name: {
          type: 'string',
          description:
            'Optional design reference name (or, with compare=previous, a capture key); omit for all',
        },
        region: {
          type: 'string',
          description: 'Stable region ID from a prior reference result',
        },
        detail: {
          type: 'string',
          enum: ['json', 'layout'],
          description:
            'json: full ledger. layout: focused painted-region measurements for one named target; excludes crops and checkpoint comparisons.',
        },
      },
    },
  },
  {
    name: 'explain',
    description:
      "Workbench projects: the settings one story or variant key would be captured with, and which layer each came from (project config, story parameters, a `stories` glob, a variant, live params, this call). Captures nothing. Use it before changing a setting, to see which layer wins. Returns juxtapose.explain/v1; a story id also lists its variants' keys.",
    inputSchema: {
      type: 'object',
      properties: {
        story: {
          type: 'string',
          description: 'Story id, or a capture key (id__variant)',
        },
        settle: SETTLE,
        network: NETWORK,
        recheck: { ...RECHECK, description: 'Report the effective mode for this call' },
      },
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
        allowUnstable: {
          type: 'boolean',
          description:
            'Allow an earlier instability verdict. Approval still captures every selected story on a fresh renderer and requires its hash to match the reviewed run. Off by default: unstable stories are refused and listed in `failed`; fix them with masks or story overrides.',
        },
      },
      required: ['stories'],
    },
  },
];

// In a real Codex discovery packet, the client repeated 1567 bytes of server
// guidance on 12 tools (17,237 redundant bytes). Keep workflows on their tools.
const INSTRUCTIONS =
  'Use saved starting evidence, edit, then capture. Labels are saved identities, not unique CSS selectors; measurements do not identify CSS causes. Ordinals count same labels in captured document order. Stop only when all required states, targets and behavior checks pass. Never approve unless the user asks.';

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

/** The `recheck` argument as the CLI flag that carries it. */
function recheckArg(args: Args): RecheckFlags {
  const v = args['recheck'];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'string' || !(RECHECK_MODES as readonly string[]).includes(v))
    throw new ArgError(
      `'recheck' must be ${RECHECK_MODES.join(', ')}; got ${JSON.stringify(v)}`,
    );
  return { recheck: v };
}

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
  // The string form keeps its own flag; anything richer travels as JSON.
  const net: SettleFlags =
    network === undefined
      ? {}
      : network.rules === undefined && typeof network.external === 'string'
        ? { 'network-external': network.external }
        : Object.keys(network).length > 0
          ? { network: JSON.stringify(network) }
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

/** Called before the run report is compacted. An additional bounded block
 * gives agents the design-target verdict they would otherwise request later. */
export async function withDesignReferenceFeedback(
  run: ToolResult,
  project: string,
  options: { progress?: boolean; previousRun?: string } = {},
): Promise<ToolResult> {
  if (run.isError) return run;
  const first = run.content[0];
  if (first?.type !== 'text') return run;
  let runId: string;
  try {
    const parsed: unknown = JSON.parse(first.text);
    if (
      !isRecord(parsed) ||
      typeof parsed['runId'] !== 'string' ||
      parsed['runId'] === 'empty' ||
      parsed['capturedCount'] === 0
    )
      return run;
    runId = parsed['runId'];
  } catch {
    return run;
  }
  try {
    const config = await loadConfig(project);
    if (!config.designReferences || !Object.keys(config.designReferences).length)
      return run;
    const { evaluateReferences } = await import('./reference.js');
    const result = await evaluateReferences({
      project,
      run: runId,
    });
    if (result.outcome === 'no-comparison') return run;
    if (options.progress) {
      const { targetProgress } = await import('./reference-progress.js');
      await targetProgress(project, result, options.previousRun).catch(() => {});
    }
    run.content.push({
      type: 'text',
      text: JSON.stringify(compactReferenceFeedback(result)),
    });
  } catch (error) {
    run.content.push({
      type: 'text',
      text: `Design reference comparison unavailable: ${error instanceof Error ? error.message : String(error)}. Call the reference tool for details.`,
    });
  }
  return run;
}

/** A checkpoint comparison now covers every shared capture, so unchanged ones
 *  are counted, not listed: a 200-story run with one edit reads as one line. */
function savedChangeText(change: ReferenceChangeResult): string {
  const count = (status: string) =>
    change.states.filter((state) => state.status === status).length;
  const notable = change.states.filter((state) => state.status !== 'unchanged');
  const counts = [
    `${count('changed')} changed`,
    `${count('unchanged')} unchanged`,
    ...(count('incompatible') ? [`${count('incompatible')} incompatible`] : []),
    ...(count('not-comparable') ? [`${count('not-comparable')} not comparable`] : []),
  ].join(', ');
  const lines = notable
    .slice(0, 8)
    .map(
      (state) =>
        `${state.name}: ${state.status}${state.changedPixels !== undefined ? `, ${state.changedPixels} changed pixels` : ''}${state.reason ? ` (${state.reason})` : ''}${state.regions?.[0] ? `, largest region ${state.regions[0].id}` : ''}`,
    );
  return [
    `Saved capture change ${change.fromRunId} → ${change.toRunId}; Pixelmatch threshold 0.1: ${counts}.`,
    ...lines,
    ...(notable.length > 8 ? [`… ${notable.length - 8} more; request detail=json.`] : []),
    ...(change.changes?.length
      ? [
          `Observed structural changes ${change.fromRunId} → ${change.toRunId}:`,
          ...change.changes.map((line) => `  ${line}`),
        ]
      : []),
    'Changed pixels describe the edit, not distance to the design target.',
  ].join('\n');
}

export function compactReferenceFeedback(result: ReferenceResult) {
  const affected = result.states.filter((state) => state.status !== 'pass');
  const passed = result.states.filter((state) => state.status === 'pass');
  affected.sort((a, b) => {
    const priority = (s: typeof a) =>
      s.status === 'error' || s.status === 'incompatible'
        ? Number.POSITIVE_INFINITY
        : (s.mismatchPixels ?? 0);
    return priority(b) - priority(a);
  });
  const states = affected.slice(0, 8).map((state) => {
    if (state.status === 'error')
      return {
        name: state.name,
        key: state.storyId,
        status: state.status,
        error: state.error.slice(0, 240),
      };
    if (state.status === 'incompatible')
      return {
        name: state.name,
        key: state.storyId,
        status: state.status,
        reason: state.reason?.slice(0, 240),
      };
    return {
      name: state.name,
      key: state.storyId,
      status: state.status,
      pixels: state.mismatchPixels,
      percent: state.mismatchPercent,
      ...(state.progress ? { progress: state.progress } : {}),
      ...(state.bestRun ? { bestRun: state.bestRun } : {}),
      ...(state.regions[0]
        ? {
            largestRegion: {
              id: state.regions[0].id,
              pixels: state.regions[0].changedPixels,
              x: state.regions[0].x,
              y: state.regions[0].y,
              width: state.regions[0].width,
              height: state.regions[0].height,
            },
          }
        : {}),
    };
  });
  return {
    schema: 'juxtapose.design-reference-hint/v1',
    runId: result.runId,
    outcome: result.outcome,
    policy: result.policy,
    counts: result.summary,
    states,
    omittedAffected: affected.length - states.length,
    passed: passed.slice(0, 8).map((state) => ({
      name: state.name,
      key: state.storyId,
      ...('progress' in state && state.progress ? { progress: state.progress } : {}),
      ...('bestRun' in state && state.bestRun ? { bestRun: state.bestRun } : {}),
    })),
    omittedPassed: Math.max(0, passed.length - 8),
    guidance:
      result.outcome === 'pass'
        ? 'Each listed captured target has compatible geometry and zero Pixelmatch mismatch pixels under the stated policy; all captured targets pass. Use the accompanying run summary for baseline and flake verdicts; no reference call is needed. Stop only when all required states and behavior checks pass. NotCaptured targets were not checked.'
        : 'Target mismatch is not a CSS cause. Request reference with name and detail=layout for focused paint measurements, detail=json for the full ledger, or a region ID for one paired crop. Saved evidence; no recapture needed.',
  };
}

/** One server: the tool handlers, the scheduler and the session browser.
 *  The transport is separate so tests can drive it without a process. */
export class McpServer {
  private browser: Promise<Browser> | null = null;
  private lending: Promise<Browser> | null = null;
  private closed = false;
  private readonly project: string;
  private readonly scheduler: Scheduler;
  private readonly reports: SavedReportCache;
  private readonly elements = new SavedElementCache();
  private readonly controlMeasurements: boolean;
  private readonly layouts = new ReferenceLayoutCache();
  /** Saved runs are immutable. Bound repeated previous/current analysis in
   * this session; a new latest run gets a different cache key. */
  private readonly referenceChanges = new Map<string, ReferenceChangeResult>();
  /** The project config's `freeze.images`, a launch setting of the session
   *  browser. */
  private readonly freezeImages: boolean | undefined;

  constructor(
    private readonly flags: McpFlags = {},
    opts: {
      snapSlots?: number;
      freezeImages?: boolean;
      controlMeasurements?: boolean;
    } = {},
  ) {
    this.freezeImages = opts.freezeImages;
    this.controlMeasurements = opts.controlMeasurements ?? true;
    this.reports = new SavedReportCache({
      controlMeasurements: this.controlMeasurements,
    });
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
      freezeImages: this.freezeImages ?? freezeImages(undefined),
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
      case 'report': {
        const runId = str(args, 'runId');
        const story = str(args, 'story');
        const detail = str(args, 'detail');
        const element = args['element'];
        if (element !== undefined && !isElementQuery(element))
          throw new ArgError(
            'element must contain exact id, testId, tag, role, name or text fields',
          );
        const properties = args['properties'];
        if (properties !== undefined) checkElementProperties(properties);
        if (element !== undefined && !story) throw new ArgError('element requires story');
        if (properties !== undefined && element === undefined)
          throw new ArgError('properties requires element');
        if (story === '') throw new ArgError("'story' must be a non-empty capture key");
        if (
          detail !== undefined &&
          detail !== 'summary' &&
          detail !== 'full' &&
          detail !== 'runs'
        )
          throw new ArgError("'detail' must be 'summary', 'full' or 'runs'");
        if (story && detail !== undefined && detail !== 'summary')
          throw new ArgError(`pass 'story' or 'detail=${detail}', not both`);
        if (runId && detail === 'runs')
          throw new ArgError("'detail=runs' lists every saved run; omit 'runId'");
        return {
          locks: this.readsRun(),
          exec: async () => {
            let data: unknown;
            if (detail === 'runs') {
              data = await savedRuns(this.project);
            } else if (story) {
              const { report, result } = await this.reports.story(
                this.project,
                story,
                runId,
              );
              if (!result)
                return errorResult(`jux: story '${story}' is not in run ${report.runId}`);
              data = element
                ? {
                    runId: report.runId,
                    storyId: story,
                    ...(await this.elements.lookup(
                      this.project,
                      report.runId,
                      story,
                      element,
                      properties,
                    )),
                  }
                : result;
            } else {
              data =
                detail === 'full'
                  ? await this.reports.get(this.project, runId)
                  : await this.reports.summary(this.project, runId);
            }
            const text = JSON.stringify(data);
            if (element && Buffer.byteLength(text) > 4096)
              return errorResult(
                'jux: saved element response exceeds the 4096-byte budget',
              );
            return {
              content: [{ type: 'text', text }],
              isError: false,
            };
          },
        };
      }
      case 'list':
        return this.run({ ...args, all: true, dryRun: true });
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
      case 'reference': {
        const name = str(args, 'name');
        const region = str(args, 'region');
        const detail = str(args, 'detail');
        const compare = str(args, 'compare') ?? 'target';
        const fromRun = str(args, 'fromRun');
        if (detail !== undefined && detail !== 'json' && detail !== 'layout')
          throw new ArgError("'detail' must be 'json' or 'layout'");
        if (detail === 'layout' && (!name || region || compare !== 'target'))
          throw new ArgError(
            "'detail=layout' requires a named target without region or compare=previous",
          );
        if (compare !== 'target' && compare !== 'previous')
          throw new ArgError("'compare' must be 'target' or 'previous'");
        if (compare === 'previous' && !fromRun)
          throw new ArgError("'fromRun' is required with compare='previous'");
        const toRun = str(args, 'toRun');
        if (compare === 'target' && (fromRun || toRun))
          throw new ArgError("'fromRun' and 'toRun' require compare='previous'");
        return {
          locks: this.readsRun(),
          exec: async (signal) => {
            if (compare === 'previous') {
              const { cropReferenceChange, evaluateReferenceChange } =
                await import('./reference.js');
              const latest = await latestRunDir(this.project);
              if (!latest) return errorResult('jux: no saved run found');
              const toRunId = toRun ?? path.basename(latest);
              // Names are resolved through project config. A live edit may
              // remap a name without changing either immutable saved run.
              const config = await loadConfig(this.project);
              const selectedReferences = name
                ? { [name]: config.designReferences?.[name] }
                : (config.designReferences ?? {});
              const referenceKey = createHash('sha256')
                .update(JSON.stringify(selectedReferences))
                .digest('hex');
              const key = JSON.stringify([toRunId, fromRun, name, referenceKey]);
              let change = this.referenceChanges.get(key);
              if (region && !change && name) {
                // A summary over all references is reusable for a later crop
                // that names just one of its states.
                const allReferenceKey = createHash('sha256')
                  .update(JSON.stringify(config.designReferences ?? {}))
                  .digest('hex');
                const allKey = JSON.stringify([
                  toRunId,
                  fromRun,
                  undefined,
                  allReferenceKey,
                ]);
                const all = this.referenceChanges.get(allKey);
                const state = all?.states.find((item) => item.name === name);
                if (all && state) change = { ...all, states: [state] };
              }
              if (region && change) {
                const crop = await cropReferenceChange({
                  project: this.project,
                  fromRun: fromRun!,
                  toRun: toRunId,
                  result: change,
                  regionId: region,
                  ...(name ? { name } : {}),
                });
                change = { ...change, crop };
              }
              if (!change) {
                change = await evaluateReferenceChange({
                  project: this.project,
                  fromRun: fromRun!,
                  toRun: toRunId,
                  ...(name ? { name } : {}),
                  ...(region ? { regionId: region } : {}),
                });
                if (!region) {
                  if (this.referenceChanges.size >= 8)
                    this.referenceChanges.delete(
                      this.referenceChanges.keys().next().value!,
                    );
                  this.referenceChanges.set(key, change);
                }
              }
              const crop = change.crop;
              const content: ToolResult['content'] = [
                {
                  type: 'text',
                  text: detail
                    ? JSON.stringify({
                        ...change,
                        crop: crop
                          ? {
                              regionId: crop.regionId,
                              box: crop.box,
                              scale: crop.scale,
                              width: crop.width,
                              height: crop.height,
                            }
                          : undefined,
                      })
                    : savedChangeText(change) +
                      (crop
                        ? `\nCrop page box ${JSON.stringify(crop.box)}; nominal scale ${crop.scale}; earlier left, later right. Content outside this box is not shown.`
                        : ''),
                },
              ];
              if (crop)
                content.push({
                  type: 'image',
                  mimeType: 'image/png',
                  data: crop.png.toString('base64'),
                });
              return { content, isError: false };
            }
            if (detail === 'layout') {
              if (signal?.aborted) return errorResult(CANCELLED);
              const { evaluateReferences } = await import('./reference.js');
              const { focusedLayoutFeedback } =
                await import('./reference-layout-feedback.js');
              const evidence = await evaluateReferences({
                project: this.project,
                name,
                includeLayout: true,
                layoutCache: this.layouts,
              });
              return {
                content: [
                  { type: 'text', text: JSON.stringify(focusedLayoutFeedback(evidence)) },
                ],
                isError:
                  evidence.outcome === 'error' || evidence.outcome === 'no-comparison',
              };
            }
            const { referenceCommand } = await import('./reference.js');
            const result = await this.invoke(
              (s) =>
                referenceCommand(
                  name,
                  {
                    ...this.common(),
                    json: Boolean(region || detail),
                    ...(region ? { region } : {}),
                  },
                  s,
                  this.layouts,
                ),
              signal,
            );
            if (!region && !detail && !result.isError) {
              const first = result.content[0];
              if (first?.type === 'text') {
                first.text = first.text
                  .replaceAll('Use --json', 'Call reference with detail=json')
                  .replaceAll('use --json', 'call reference with detail=json');
              }
            }
            if (region && !result.isError) {
              const first = result.content[0];
              if (first?.type === 'text') {
                const parsed = JSON.parse(first.text) as {
                  crop?: {
                    regionId: string;
                    pngBase64: string;
                    box: { x: number; y: number; width: number; height: number };
                    scale: number;
                    width: number;
                    height: number;
                  };
                  [key: string]: unknown;
                };
                if (parsed.crop) {
                  const { pngBase64, ...metadata } = parsed.crop;
                  const { regionId, box, scale } = metadata;
                  delete parsed.crop;
                  first.text = detail
                    ? JSON.stringify({ ...parsed, crop: metadata })
                    : `Design reference crop ${regionId}: target on the left, current capture on the right. Page box ${JSON.stringify(box)}; nominal scale ${scale}. Content outside this box is not shown. Re-run reference for a fresh region ID if either image changed.`;
                  result.content.push({
                    type: 'image',
                    mimeType: 'image/png',
                    data: pngBase64,
                  });
                }
              }
            }
            return result;
          },
        };
      }
      case 'explain': {
        const story = str(args, 'story', true)!;
        const settle = settleArg(args);
        const recheck = recheckArg(args);
        return {
          // Discovery shares run's cache directory, so it waits for a run.
          locks: this.readsRun(),
          exec: (signal) =>
            this.invoke(
              async (s) =>
                (await import('./config.js')).configCommand(
                  {
                    ...this.common(),
                    explain: story,
                    callSource: 'mcp',
                    ...settle,
                    ...recheck,
                  },
                  { ...s, browser: this.lend },
                ),
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
    const device = str(args, 'device');
    const orientation = str(args, 'orientation');
    if (
      orientation !== undefined &&
      orientation !== 'portrait' &&
      orientation !== 'landscape'
    )
      throw new ArgError("'orientation' must be 'portrait' or 'landscape'");
    if (args.fullPage !== undefined && typeof args.fullPage !== 'boolean')
      throw new ArgError("'fullPage' must be a boolean");
    const fullPage = args.fullPage === true;
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
                ...(device ? { device } : {}),
                ...(orientation ? { orientation } : {}),
                ...(fullPage ? { 'full-page': true } : {}),
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
    const dryRun = bool(args, 'dryRun');
    const compareTo = str(args, 'compareTo');
    if (compareTo !== undefined && !/^[a-zA-Z0-9_-]+$/.test(compareTo))
      throw new ArgError("'compareTo' must be a saved run ID or 'previous'");
    const progress = bool(args, 'progress');
    if (dryRun && (compareTo !== undefined || progress))
      throw new ArgError("'compareTo' and 'progress' require a capture, not dryRun");
    const feedback = str(args, 'feedback') ?? 'target';
    if (feedback !== 'target' && feedback !== 'none')
      throw new ArgError("'feedback' must be 'target' or 'none'");
    if (progress && feedback === 'none')
      throw new ArgError("'progress' requires feedback='target'");
    const since = str(args, 'since');
    const stories = strings(args, 'stories');
    const settle = settleArg(args);
    const recheck = recheckArg(args);
    const reportDetail = str(args, 'report');
    if (
      reportDetail !== undefined &&
      reportDetail !== 'summary' &&
      reportDetail !== 'full'
    )
      throw new ArgError("'report' must be 'summary' or 'full'");
    return {
      locks: EXCLUSIVE,
      exec: async (signal) => {
        // Resolve under the capture lock: a queued run must compare to the
        // last completed run, never to itself or a half-written neighbour.
        const previous =
          compareTo === 'previous' || progress ? await latestRunDir(this.project) : null;
        const previousRun = previous ? path.basename(previous) : undefined;
        const fromRun = compareTo === 'previous' ? previousRun : compareTo;
        if (compareTo && !fromRun)
          return errorResult('jux: no saved checkpoint; run without compareTo first');
        // Invalid checkpoints fail before spending a browser capture.
        if (fromRun) await this.reports.get(this.project, fromRun);
        const { runCommand } = await import('./run.js');
        const result = await this.invoke(
          (s) =>
            runCommand(
              {
                ...this.common(),
                ...(all ? { all } : {}),
                ...(dryRun ? { 'dry-run': true } : {}),
                ...(since ? { since } : {}),
                ...(stories?.length ? { story: stories } : {}),
                ...settle,
                ...recheck,
              },
              { ...s, browser: this.lend },
            ),
          signal,
        );
        if (dryRun || result.isError) return result;
        const withFeedback =
          feedback === 'none'
            ? result
            : await withDesignReferenceFeedback(result, this.project, {
                progress,
                ...(previousRun ? { previousRun } : {}),
              });
        if (fromRun) {
          const first = result.content[0];
          if (first?.type === 'text') {
            const report = parseRunReport(first.text);
            if (report.capturedCount > 0 && report.runId !== 'empty') {
              try {
                const change = await this.savedChange(fromRun, report.runId);
                withFeedback.content.push({
                  type: 'text',
                  text: `${change.schema}\n${savedChangeText(change)}`,
                });
              } catch (error) {
                withFeedback.content.push({
                  type: 'text',
                  text: `Saved checkpoint comparison unavailable: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
            }
          }
        }
        if (reportDetail === 'full') return withFeedback;
        const first = withFeedback.content[0];
        if (first?.type === 'text') {
          const report = parseRunReport(first.text);
          first.text = JSON.stringify(
            agentRunSummary(report, {
              controlMeasurements: this.controlMeasurements,
            }),
          );
        }
        return withFeedback;
      },
    };
  }

  private async savedChange(fromRun: string, toRun: string) {
    const config = await loadConfig(this.project);
    const referenceKey = createHash('sha256')
      .update(JSON.stringify(config.designReferences ?? {}))
      .digest('hex');
    const key = JSON.stringify([toRun, fromRun, undefined, referenceKey]);
    let change = this.referenceChanges.get(key);
    if (!change) {
      const { evaluateReferenceChange } = await import('./reference.js');
      change = await evaluateReferenceChange({ project: this.project, fromRun, toRun });
      if (this.referenceChanges.size >= 8)
        this.referenceChanges.delete(this.referenceChanges.keys().next().value!);
      this.referenceChanges.set(key, change);
    }
    return change;
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
          (s) =>
            approveCommand(
              {
                ...this.common(),
                run: runDir,
                story: stories,
                ...(bool(args, 'allowUnstable') === true
                  ? { 'allow-unstable': true }
                  : {}),
              },
              // The confirming capture of a story the run did not recheck.
              { ...s, browser: this.lend },
            ),
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
  // Once at startup, on stderr (stdout is the protocol); each snap and run
  // call also reports them in its own result.
  for (const m of configWarnings(config)) process.stderr.write(`jux mcp: ${m}\n`);
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

  const server = new McpServer(flags, { snapSlots, freezeImages: freezeImages(config) });
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
