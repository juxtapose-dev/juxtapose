// The confirming capture `jux approve` takes for stories the run did not
// recheck (#195). It sets the same stage the run does (enumerate, discover
// variants, serve the build, launch a browser) and captures just those
// stories once more.

import path from 'node:path';
import {
  acquireBrowser,
  confirmCaptures,
  DEFAULT_VIEWPORT,
  expandVariants,
  prepareCaptures,
  type CaptureEnv,
  type Confirmation,
} from '@juxtapose/core';
import type { Context } from '../context.js';
import type { Io, Session } from '../io.js';
import { serveStatic } from '../serve-static.js';
import { errorMessage } from '../guards.js';

/** Capture each of `hashes`' stories again and compare. Never throws: a story
 *  that cannot be captured is `unconfirmed`, which approve refuses just like
 *  an unstable one. */
export async function confirmForApprove(
  ctx: Context,
  hashes: ReadonlyMap<string, string>,
  env: CaptureEnv | undefined,
  flags: { chrome?: string; 'no-daemon'?: boolean },
  { browser: lent, signal }: Session,
  io: Io,
): Promise<Map<string, Confirmation>> {
  const unconfirmed = (reason: string) =>
    new Map(
      [...hashes].map(([storyId, hash]): [string, Confirmation] => [
        storyId,
        { storyId, unstable: { hashes: [hash], unconfirmed: reason } },
      ]),
    );
  if (hashes.size === 0) return new Map();
  if (!ctx.json)
    io.err(
      `jux: capturing ${hashes.size} ${hashes.size === 1 ? 'story' : 'stories'} on fresh renderers before approving\n`,
    );
  const needsServer = !ctx.origin && ctx.platform.name !== 'urls';
  let server: Awaited<ReturnType<typeof serveStatic>> | null = null;
  let browser: Awaited<ReturnType<typeof acquireBrowser>> | undefined;
  try {
    const enumerated = await ctx.platform.enumerate({
      projectRoot: ctx.projectRoot,
      buildDir: ctx.buildDir,
      origin: ctx.origin,
    });
    server = needsServer ? await serveStatic(ctx.buildDir!) : null;
    const baseUrl = ctx.origin ?? server?.url ?? 'about:blank';
    browser = lent
      ? await lent()
      : await acquireBrowser({
          chrome: flags.chrome,
          noDaemon: flags['no-daemon'] === true,
        });
    const captures = ctx.platform.discoverParams
      ? await prepareCaptures(enumerated, {
          platform: ctx.platform,
          browser,
          baseUrl,
          viewport: ctx.config.viewport ?? DEFAULT_VIEWPORT,
          ...(ctx.config.variants ? { projectVariants: ctx.config.variants } : {}),
          ...(ctx.config.stories ? { projectStories: ctx.config.stories } : {}),
          onWarning: (m) => io.err(`${m}\n`),
          cache: {
            dir: path.join(ctx.projectRoot, '.juxtapose', 'runs', '.cache'),
            target: {
              projectRoot: ctx.projectRoot,
              ...(ctx.buildDir ? { buildDir: ctx.buildDir } : {}),
              ...(ctx.origin ? { origin: ctx.origin } : {}),
            },
          },
        })
      : expandVariants(enumerated, ctx.config.variants, ctx.config.stories);
    const stories = captures.filter((s) => hashes.has(s.storyId));
    const found = new Set(stories.map((s) => s.storyId));
    const missing = [...hashes.keys()].filter((id) => !found.has(id));
    const results = new Map(
      (
        await confirmCaptures({
          browser,
          platform: ctx.platform,
          baseUrl,
          config: ctx.config,
          stories,
          hashes,
          ...(env ? { env } : {}),
          ...(signal ? { signal } : {}),
          onProgress: (done, total, storyId) => {
            if (!ctx.json)
              io.err(`\r  confirm ${done}/${total}  ${storyId.slice(0, 40).padEnd(40)}`);
          },
        })
      ).map((c): [string, Confirmation] => [c.storyId, c]),
    );
    if (!ctx.json) io.err('\r' + ' '.repeat(70) + '\r');
    for (const id of missing)
      results.set(id, {
        storyId: id,
        unstable: {
          hashes: [hashes.get(id)!],
          unconfirmed: 'the story is no longer in the project',
        },
      });
    return results;
  } catch (err) {
    return unconfirmed(errorMessage(err));
  } finally {
    // A lent browser belongs to the session (`jux mcp`) and outlives this call.
    if (!lent) await browser?.close().catch(() => {});
    await server?.close();
  }
}
