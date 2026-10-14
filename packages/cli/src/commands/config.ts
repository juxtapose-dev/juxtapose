// `jux config --explain <storyId>` (issue #179): the effective capture
// settings for one story or variant key, and which layer each came from.
//
// Discovery runs as it does for `jux run` (cached the same way); nothing is
// captured. A platform that reads live params gets one story rendered to ask.

import path from 'node:path';
import {
  acquireBrowser,
  checkProjectSettle,
  configWarnings,
  DEFAULT_VIEWPORT,
  explainCapture,
  expandVariants,
  findCaptures,
  liveReader,
  prepareCaptures,
  ProvenanceLog,
  VariantConfigError,
  type Browser,
  type Explanation,
  type Page,
  type Source,
  type StoryManifest,
} from '@juxtapose/core';
import { resolveContext, type CommonFlags } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { stdio, type Session } from '../io.js';
import { serveStatic } from '../serve-static.js';
import { recheckFromFlags } from '../recheck-flags.js';
import { settleFromFlags } from '../settle-flags.js';
import { closest } from '../suggest.js';

export interface ConfigFlags extends CommonFlags {
  explain?: string;
  /** Who supplied the settle and network flags: the shell (default) or the MCP tool. */
  callSource?: 'cli' | 'mcp';
}

export async function configCommand(
  flags: ConfigFlags,
  { io = stdio, browser: lent, signal }: Session = {},
): Promise<number> {
  if (flags.explain === undefined) {
    io.err('jux config: nothing to do. Try `jux config --explain <storyId>`.\n');
    return EXIT.usage;
  }
  const id = flags.explain;
  const call = settleFromFlags(flags, 'jux config');
  if ('error' in call) {
    io.err(`${call.error}\n`);
    return EXIT.usage;
  }
  const recheck = recheckFromFlags(flags, 'jux config');
  if ('error' in recheck) {
    io.err(`${recheck.error}\n`);
    return EXIT.usage;
  }
  const ctx = await resolveContext(flags);
  try {
    checkProjectSettle(ctx.config);
  } catch (err) {
    return configError(err, io);
  }
  for (const m of configWarnings(ctx.config)) io.err(`jux: ${m}\n`);

  const enumerated = await ctx.platform.enumerate({
    projectRoot: ctx.projectRoot,
    buildDir: ctx.buildDir,
    origin: ctx.origin,
  });
  if (enumerated.length === 0) {
    io.err('jux: no stories found\n');
    return 1;
  }

  const needsServer = !ctx.origin && ctx.platform.name !== 'urls';
  const needsBrowser =
    ctx.platform.discoverParams !== undefined ||
    ctx.platform.readLiveParams !== undefined;
  const server = needsServer && needsBrowser ? await serveStatic(ctx.buildDir!) : null;
  const baseUrl = ctx.origin ?? server?.url ?? 'about:blank';

  // Launched only if something needs a page: a cached discovery on a platform
  // with no live params never starts one.
  let browser: Promise<Browser> | undefined;
  const getBrowser = () =>
    (browser ??= lent
      ? lent()
      : acquireBrowser({ chrome: flags.chrome, noDaemon: flags['no-daemon'] === true }));
  const viewport = ctx.config.viewport ?? DEFAULT_VIEWPORT;
  let close: (() => Promise<void>) | undefined;
  const getPage = async (): Promise<Page> => {
    const context = await (await getBrowser()).newContext({ viewport });
    close = () => context.close().catch(() => {});
    return context.newPage();
  };

  // A cancelled call stops waiting at once (and releases what it holds in the
  // `finally`); the browser work it left behind is closed with the context.
  const cancelled = new Promise<never>((_, reject) => {
    const stop = () => reject(new Cancelled());
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
  cancelled.catch(() => {});
  const until = <T>(p: Promise<T>): Promise<T> => Promise.race([p, cancelled]);

  try {
    const log = new ProvenanceLog();
    let captures: StoryManifest[];
    try {
      captures = ctx.platform.discoverParams
        ? await until(
            prepareCaptures(enumerated, {
              platform: ctx.platform,
              // Only `newContext` is called, and only on a cache miss.
              browser: {
                newContext: async (o: Parameters<Browser['newContext']>[0]) =>
                  (await getBrowser()).newContext(o),
              } as unknown as Browser,
              baseUrl,
              viewport,
              ...(ctx.config.variants ? { projectVariants: ctx.config.variants } : {}),
              ...(ctx.config.stories ? { projectStories: ctx.config.stories } : {}),
              trace: log,
              onWarning: (m) => io.err(`${m}\n`),
              cache: {
                dir: path.join(ctx.projectRoot, '.juxtapose', 'runs', '.cache'),
                target: {
                  projectRoot: ctx.projectRoot,
                  ...(ctx.buildDir ? { buildDir: ctx.buildDir } : {}),
                  ...(ctx.origin ? { origin: ctx.origin } : {}),
                },
              },
            }),
          )
        : expandVariants(enumerated, ctx.config.variants, ctx.config.stories, log);
    } catch (err) {
      return configError(err, io);
    }

    const found = findCaptures(captures, id);
    if (!found) {
      const near = closest(
        id,
        captures.map((c) => c.storyId),
      );
      io.err(
        `jux config: no story or capture with id '${id}'.` +
          (near.length > 0
            ? ` Did you mean ${near.map((n) => `'${n}'`).join(', ')}?`
            : '') +
          '\n',
      );
      return EXIT.usage;
    }

    let live;
    const read = liveReader(ctx.platform, getPage, baseUrl);
    if (read) {
      try {
        live = await until(read(found.capture));
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        io.err(
          `jux: could not read live parameters for '${id}' (${
            err instanceof Error ? err.message : String(err)
          }); showing the other layers\n`,
        );
      }
    }

    const explanation = explainCapture(
      found.capture,
      log,
      {
        config: ctx.config,
        callLayer: flags.callSource ?? 'cli',
        ...(recheck.recheck ? { recheck: recheck.recheck } : {}),
        ...(call.settle || call.network
          ? {
              call: {
                ...(call.settle ? { settle: call.settle } : {}),
                ...(call.network ? { network: call.network } : {}),
              },
            }
          : {}),
        ...(live ? { live } : {}),
      },
      found.variants,
    );
    io.out(ctx.json ? JSON.stringify(explanation, null, 2) + '\n' : format(explanation));
    return 0;
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    io.err('jux: cancelled\n');
    return EXIT.failure;
  } finally {
    await close?.();
    if (!lent && browser) await (await browser).close().catch(() => {});
    await server?.close();
  }
}

class Cancelled extends Error {}

function configError(err: unknown, io: { err(s: string): void }): number {
  if (!(err instanceof VariantConfigError)) throw err;
  io.err(`${err.message}\n`);
  return EXIT.usage;
}

const LAYERS: Record<Exclude<Source['layer'], 'stories' | 'variant'>, string> = {
  mcp: 'MCP arguments',
  default: 'default',
  project: 'project config',
  story: 'story parameters',
  live: 'live params',
  cli: 'CLI flag',
};

export function sourceLabel(s: Source): string {
  if (s.layer === 'stories') return `stories['${s.detail}']`;
  if (s.layer === 'variant') return `variant ${s.detail}`;
  return LAYERS[s.layer];
}

function show(setting: string, value: unknown): string {
  if (setting === 'viewport' && typeof value === 'object' && value !== null) {
    const v = value as { width: number; height: number };
    return `${v.width}x${v.height}`;
  }
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The human table. */
export function format(e: Explanation): string {
  const lines: string[] = [];
  lines.push(
    e.baseStoryId === undefined
      ? e.storyId
      : `${e.storyId}  (variant ${e.variant} of ${e.baseStoryId}${
          e.extends?.length ? `, extends ${e.extends.join(' > ')}` : ''
        })`,
  );
  if (e.matched.stories.length > 0)
    lines.push(`matched stories globs: ${e.matched.stories.join(', ')}`);
  if (e.skipped) lines.push('skipped: this capture is not taken');
  lines.push('');
  const rows = e.settings.map((s) => [
    s.setting,
    show(s.setting, s.value),
    s.source.map(sourceLabel).join(' + '),
  ]);
  const head = ['SETTING', 'VALUE', 'SOURCE'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (i < 2 ? c.padEnd(w[i]!) : c))
      .join('  ')
      .trimEnd();
  lines.push(line(head), ...rows.map(line));
  if (e.matched.networkRules.length > 0) {
    lines.push('', 'network rules (first match wins):');
    for (const r of e.matched.networkRules)
      lines.push(`  ${r.action.padEnd(11)} ${r.match}  ${sourceLabel(r.source)}`);
  }
  for (const n of e.notes) lines.push('', `note: ${n}`);
  if (e.variants?.length) {
    lines.push('', 'variants (jux config --explain <key>):');
    for (const v of e.variants) lines.push(`  ${v}`);
  }
  return lines.join('\n') + '\n';
}
