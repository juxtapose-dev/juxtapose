// Storybook platform adapter.
//
// Everything in this file is Storybook-specific by design. If it compiles
// against @juxtapose/core's Platform interface and nothing here leaks upward,
// the seam holds.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { navigateToStory } from '@juxtapose/core';
import type {
  Page,
  Platform,
  EnumerateTarget,
  SettleContext,
  StoryManifest,
  StoryParams,
} from '@juxtapose/core';

// The `window as unknown as {…}` casts below sit inside page.evaluate
// callbacks: they run in the page, and the globals they read are Storybook
// internals with no published types. The cast is the claim; the code still
// checks each value before using it.

interface StorybookIndexEntry {
  id: string;
  type?: 'story' | 'docs';
  title: string;
  name: string;
  importPath: string;
  parameters?: { juxtapose?: StoryParams };
}

interface StorybookIndex {
  v?: number;
  entries: Record<string, StorybookIndexEntry>;
}

/** The check this file always made (a truthy `entries`), now on `unknown`;
 *  entries are read field by field downstream. */
const isStorybookIndex = (v: unknown): v is StorybookIndex =>
  typeof v === 'object' && v !== null && 'entries' in v && Boolean(v.entries);

/**
 * Phases where the story is settled enough to screenshot.
 *
 * An allowlist, not a denylist. Storybook's RenderPhase union is
 * `preparing | loading | beforeEach | rendering | playing | played |
 * afterEach | completed | finished | aborted | errored` — listing only the
 * few we consider "still working" means any phase added later, or any
 * transient one we forgot (`beforeEach` and `afterEach` both qualify),
 * silently reads as ready and we screenshot mid-flight.
 *
 * `errored` and `aborted` are included deliberately: a story that failed to
 * render should produce a capture showing that, which is a reviewable diff,
 * rather than hanging until the timeout.
 */
const READY_PHASES = ['played', 'completed', 'finished', 'errored', 'aborted'];

/**
 * Phases meaning the play function has finished.
 *
 * Used when a story opts into `captureAfterPlay`. Narrower than READY_PHASES
 * because the point is to wait for interactions to complete.
 */
const PLAYED_PHASES = ['played', 'completed', 'finished'];

export class StorybookPlatform implements Platform {
  readonly name = 'storybook';

  async detect(target: EnumerateTarget): Promise<boolean> {
    if (target.origin) {
      try {
        const res = await fetch(new URL('index.json', withSlash(target.origin)));
        return res.ok;
      } catch {
        return false;
      }
    }
    if (!target.buildDir) return false;
    return (await readIndex(target.buildDir)) !== null;
  }

  async enumerate(target: EnumerateTarget): Promise<StoryManifest[]> {
    const index = target.origin
      ? await fetchIndex(target.origin)
      : await readIndex(target.buildDir!);

    if (!index) {
      throw new Error(
        `[storybook] no index.json at ${target.origin ?? target.buildDir}. ` +
          `Build Storybook first, or point --origin at a running dev server.`,
      );
    }

    // `importPath` is relative to the project root, not the build dir.
    const base = target.projectRoot;

    return Object.values(index.entries)
      .filter((e) => e.type !== 'docs')
      .map<StoryManifest>((e) => ({
        storyId: e.id,
        title: e.title,
        name: e.name,
        componentPath: path.resolve(base, e.importPath),
        // Storybook does not serialize arbitrary parameters into index.json,
        // so this is almost always empty in practice — readLiveParams is what
        // actually resolves per-story config. Kept because a custom indexer
        // may include them, and an empty object is the correct fallback.
        params: e.parameters?.juxtapose ?? {},
      }))
      .sort((a, b) => a.storyId.localeCompare(b.storyId));
  }

  storyUrl(baseUrl: string, storyId: string): string {
    return `${stripSlash(baseUrl)}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;
  }

  /** URL-addressable, so showing a story is just a navigation. */
  async showStory(page: Page, storyId: string, baseUrl: string): Promise<void> {
    await navigateToStory((b, s) => this.storyUrl(b, s))(page, storyId, baseUrl);
  }

  /** Blank preview URL, for warming a page before any story is selected. */
  previewUrl(baseUrl: string): string {
    return `${stripSlash(baseUrl)}/iframe.html`;
  }

  async settle(page: Page, ctx: SettleContext): Promise<void> {
    await waitForRenderPhase(page, ctx);
    await waitForLayoutClass(page);
  }

  /**
   * Switch stories on a warm page by emitting on Storybook's own channel.
   *
   * This is the single largest optimization in the tool — ~4x per story,
   * because it re-renders instead of reloading the bundle and re-registering
   * the service worker. Returns false if the preview runtime isn't reachable,
   * and the pool falls back to a navigation.
   */
  async switchStory(page: Page, storyId: string, ctx: SettleContext): Promise<boolean> {
    const outcome = await page
      .evaluate(
        ({ id, timeoutMs, ready, played, afterPlay }) =>
          new Promise<string>((resolve) => {
            const w = window as unknown as {
              __STORYBOOK_PREVIEW__?: {
                channel?: {
                  on(ev: string, cb: (...a: unknown[]) => void): void;
                  removeListener(ev: string, cb: (...a: unknown[]) => void): void;
                  emit(ev: string, payload: unknown): void;
                };
                storyRenders?: { id: string; phase?: string }[];
              };
            };
            const preview = w.__STORYBOOK_PREVIEW__;
            const channel = preview?.channel;
            if (!channel) return resolve('unsupported');

            const isReady = (phase: string | undefined): boolean =>
              afterPlay
                ? !!phase && played.includes(phase)
                : !!phase && ready.includes(phase);

            // Check the phase we may already be in before subscribing —
            // otherwise a story that renders faster than this evaluate
            // deadlocks waiting for an event that already fired.
            const current = preview?.storyRenders?.find((r) => r.id === id);
            if (current && isReady(current.phase)) return resolve('switched');

            let settled = false;
            const finish = (result: string) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              for (const ev of events) channel.removeListener(ev, onEvent);
              resolve(result);
            };

            const onEvent = (...args: unknown[]) => {
              const payload = args[0] as { storyId?: string; newPhase?: string } | string;
              if (typeof payload === 'string') {
                if (payload === id) finish('switched');
                return;
              }
              if (payload?.storyId && payload.storyId !== id) return;
              if (payload?.newPhase !== undefined) {
                if (isReady(payload.newPhase)) finish('switched');
                return;
              }
              finish('switched');
            };

            const events = [
              'storyRendered',
              'storyUnchanged',
              'storyRenderPhaseChanged',
              'storyMissing',
              'storyErrored',
              'storyThrewException',
            ];
            const timer = setTimeout(() => finish('timeout'), timeoutMs);
            for (const ev of events) channel.on(ev, onEvent);

            channel.emit('setCurrentStory', { storyId: id, viewMode: 'story' });
          }),
        {
          id: storyId,
          timeoutMs: ctx.timeoutMs,
          ready: READY_PHASES,
          played: PLAYED_PHASES,
          afterPlay: ctx.params.captureAfterPlay === true,
        },
      )
      .catch(() => 'unsupported');

    // A timeout still switched the story — the render just ran long. Capture
    // it rather than falling back to a navigation that would be slower and no
    // more correct. A genuinely broken story shows up as a visible diff.
    return outcome === 'switched' || outcome === 'timeout';
  }

  /**
   * Read parameters from the live preview.
   *
   * Necessary because Storybook only serializes a whitelist of parameters into
   * index.json, so `parameters.juxtapose` is frequently absent there even when
   * the story declares it. The original tool read the index in one code path
   * and the live DOM in another, which meant per-story thresholds were silently
   * ignored in the addon. Reading live everywhere keeps one source of truth.
   */
  async readLiveParams(page: Page, storyId: string): Promise<StoryParams | undefined> {
    return page
      .evaluate((id) => {
        const w = window as unknown as {
          __STORYBOOK_PREVIEW__?: {
            storyRenders?: {
              id: string;
              story?: { parameters?: { juxtapose?: unknown } };
            }[];
          };
        };
        const render = w.__STORYBOOK_PREVIEW__?.storyRenders?.find((r) => r.id === id);
        return render?.story?.parameters?.juxtapose ?? undefined;
      }, storyId)
      .catch(() => undefined);
  }

  /** Directories whose changes invalidate every story. */
  readonly configDirs = ['.storybook'];
  // .svelte is included for addon-svelte-csf, which is how most Svelte
  // projects author stories; omitting it would silently under-detect changes
  // for that ecosystem.
  readonly storyFileGlobs = [
    '**/*.stories.@(ts|tsx|js|jsx|mjs|svelte)',
    '**/*.story.@(ts|tsx|js|jsx|mjs|svelte)',
  ];
}

async function waitForRenderPhase(page: Page, ctx: SettleContext): Promise<void> {
  const afterPlay = ctx.params.captureAfterPlay === true;
  await page
    .waitForFunction(
      ({ id, ready, played, wantPlayed }) => {
        const w = window as unknown as {
          __STORYBOOK_PREVIEW__?: { storyRenders?: { id: string; phase?: string }[] };
        };
        const render = w.__STORYBOOK_PREVIEW__?.storyRenders?.find((r) => r.id === id);
        if (!render) return false;
        const phase = render.phase;
        if (!phase) return false;
        return wantPlayed ? played.includes(phase) : ready.includes(phase);
      },
      {
        id: ctx.story.storyId,
        ready: READY_PHASES,
        played: PLAYED_PHASES,
        wantPlayed: afterPlay,
      },
      { timeout: ctx.timeoutMs },
    )
    // Timing out is not an error: screenshot what's on screen. A story that
    // renders late should surface as a diff a human can judge, not as an
    // exception that aborts the run.
    .catch(() => {});
}

/**
 * Wait for Storybook's layout class, which proves the decorator chain applied.
 *
 * Without this, a story can be "rendered" per the phase machine but not yet
 * laid out, and the screenshot catches it mid-flow.
 */
async function waitForLayoutClass(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const cls = document.body?.classList;
        return (
          !!cls &&
          (cls.contains('sb-main-padded') ||
            cls.contains('sb-main-centered') ||
            cls.contains('sb-main-fullscreen'))
        );
      },
      undefined,
      { timeout: 2000 },
    )
    .catch(() => {});
}

async function readIndex(buildDir: string): Promise<StorybookIndex | null> {
  for (const name of ['index.json', 'stories.json']) {
    try {
      const raw = await readFile(path.join(buildDir, name), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isStorybookIndex(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function fetchIndex(origin: string): Promise<StorybookIndex | null> {
  try {
    const res = await fetch(new URL('index.json', withSlash(origin)));
    if (!res.ok) return null;
    const parsed: unknown = await res.json();
    return isStorybookIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const withSlash = (u: string) => (u.endsWith('/') ? u : u + '/');
const stripSlash = (u: string) => u.replace(/\/+$/, '');
