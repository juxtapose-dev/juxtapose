// A ReviewSource backed by run artifacts on disk plus a live capture pool.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  approveCapture,
  compareCodeUnits,
  expandVariants,
  computeGroups,
  buildHandoffPrompt,
  handoffVariant,
  createAncestryCheck,
  alwaysAncestor,
  acquireBrowser,
  type Browser,
  encodeStoryId,
  hashImage,
  resolveAffectedFromPaths,
  runCapture,
  DEFAULT_VIEWPORT,
  type BaselineStore,
  type Platform,
  type ProjectConfig,
  parseRunReport,
  platformStoryId,
  prepareCaptures,
  selectByStoryId,
  VariantConfigError,
  checkProjectSettle,
  type RunReport,
  type StoryManifest,
} from '@juxtapose/core';
import type { ImageKind, ReviewBundle, ReviewSource, RunProgress } from './types.js';

export interface SourceOptions {
  projectRoot: string;
  platform: Platform;
  store: BaselineStore;
  config: ProjectConfig;
  /** Where the workbench is served. For the addon this is Storybook's own
   *  dev server, which is why it can change between requests. */
  baseUrl: string;
  runDir: string;
  branch: string;
  commitSha: string;
  /** A previous static build, if one happens to exist. Only used to widen
   *  watch-mode recapture from "this component" to "everything importing it" —
   *  the dev server has no bundler graph of its own. Absent is normal. */
  buildDir?: string;
}

/**
 * Which of the matched stories to actually recapture.
 *
 * Separate from the fetching around it so the rule is testable without a
 * browser or a store. The trigger is always included: the developer is looking
 * at it, and it may not appear in the graph walk at all when the manifest never
 * recorded its file.
 */
export function watchTargets(
  triggerId: string,
  matched: readonly StoryManifest[],
): string[] {
  const ids = new Set([triggerId]);
  for (const s of matched) {
    if (s.params.liveCapture !== false) ids.add(s.storyId);
  }
  return [...ids];
}

export class RunDirSource implements ReviewSource {
  private report: RunReport | null = null;
  /** In flight or settled: concurrent callers share one discovery. */
  private storyCache: Promise<StoryManifest[]> | null = null;
  private indexCache: Promise<StoryManifest[]> | null = null;
  /** A variant config error, kept until the stories or the config file
   *  change: retrying it on every poll would relaunch discovery each time. */
  private configError: { error: VariantConfigError; configStamp: string } | null = null;
  private readonly affectedCache = new Map<string, string[]>();
  private browser: Browser | null = null;

  private running = false;
  private done = 0;
  private total = 0;
  private currentStory: string | null = null;
  private abort: AbortController | null = null;

  /**
   * Approvals are serialized through this chain.
   *
   * "Approve all" fires N parallel requests and each one is a read-modify-write
   * of the same manifest file. Without a queue the last writer wins and every
   * other approval is silently lost — which is exactly the kind of bug that
   * erodes trust in the tool.
   */
  private approvalQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SourceOptions) {}

  setBaseUrl(baseUrl: string): void {
    this.opts.baseUrl = baseUrl;
  }

  async bundle(): Promise<ReviewBundle> {
    const report = await this.loadReport();
    const manifest = await this.opts.store.readManifest();

    // A story counts as approved if its captured bytes now match the manifest.
    // Deriving this rather than storing it means an approval made through the
    // CLI shows up in the panel without any shared state between them.
    const approved: string[] = [];
    for (const result of report?.results ?? []) {
      if (result.status === 'pass') continue;
      const entry = manifest.baselines[result.storyId];
      if (!entry) continue;
      const current = await this.readImage('current', result.storyId);
      if (current && hashImage(current) === entry.hash) approved.push(result.storyId);
    }

    return { report, approved, running: this.running };
  }

  async progress(): Promise<RunProgress> {
    return {
      running: this.running,
      done: this.done,
      total: this.total,
      storyId: this.currentStory,
    };
  }

  /**
   * Every capture: the enumerated stories with the params the preview
   * declares (when the platform can discover them) and their variants
   * expanded. Keyed by capture key, like everything the run writes.
   */
  async stories(): Promise<StoryManifest[]> {
    if (this.configError) {
      if (this.configError.configStamp === configStamp(this.opts.projectRoot))
        throw this.configError.error;
      this.configError = null;
    }
    this.storyCache ??= this.loadStories();
    const pending = this.storyCache;
    try {
      return await pending;
    } catch (err) {
      // Not cached as a result: the next call retries, unless the error is
      // the user's config, which only an edit can fix.
      if (this.storyCache === pending) this.storyCache = null;
      if (err instanceof VariantConfigError)
        this.configError = {
          error: err,
          configStamp: configStamp(this.opts.projectRoot),
        };
      throw err;
    }
  }

  /** The platform's own stories, without discovery: enough for a title or a
   *  source path, and never starts a browser. */
  private indexStories(): Promise<StoryManifest[]> {
    this.indexCache ??= this.opts.platform
      .enumerate({ projectRoot: this.opts.projectRoot, origin: this.opts.baseUrl })
      .catch((err: unknown) => {
        this.indexCache = null;
        throw err;
      });
    return this.indexCache;
  }

  private async loadStories(): Promise<StoryManifest[]> {
    // The project's settle options, checked like its variants: a
    // SettleConfigError is a VariantConfigError, so it is cached and served
    // as a config error naming `project config`, not a failure per story.
    checkProjectSettle(this.opts.config);
    const enumerated = await this.indexStories();
    const projectVariants = this.opts.config.variants;
    // Discovery needs a page, so it only runs for a platform that has it; the
    // browser it starts is the one the next capture would start anyway.
    return this.opts.platform.discoverParams
      ? prepareCaptures(enumerated, {
          platform: this.opts.platform,
          browser: await this.ensureBrowser(),
          baseUrl: this.opts.baseUrl,
          viewport: this.opts.config.viewport ?? DEFAULT_VIEWPORT,
          ...(projectVariants ? { projectVariants } : {}),
          onWarning: (m) => process.stderr.write(`juxtapose: ${m}\n`),
        })
      : expandVariants(enumerated, projectVariants);
  }

  /** Drop the cached story index — the workbench told us it changed. */
  flushStories(): void {
    this.storyCache = null;
    this.indexCache = null;
    // A story edit may be the fix for a variant declaration error.
    this.configError = null;
    // Component paths may have moved, so the answers keyed off them are stale
    // too. Cheap to rebuild; wrong to keep.
    this.affectedCache.clear();
  }

  async flushIndex(): Promise<void> {
    this.flushStories();
  }

  /**
   * Which stories to recapture when `storyId` rerenders.
   *
   * A rerender means the story's own module graph changed, so the unit of
   * change is its component path — every story sharing that path is suspect,
   * not just the one on screen. With a build available the import graph widens
   * this to dependents; without one it stays at the file, which is the honest
   * limit of what a dev server can tell us.
   *
   * Memoised because this is asked on every rerender and the answer only moves
   * when the index does.
   */
  async affected(storyId: string): Promise<string[]> {
    const cached = this.affectedCache.get(storyId);
    if (cached) return cached;

    // The workbench rerenders a story by its own id; what gets recaptured is
    // every capture of it, variants included, and of whatever shares its
    // component. Keys, so the run takes exactly these captures.
    const stories = await this.stories();
    const keysFor = (ids: string[]) =>
      selectByStoryId(stories, ids).selected.map((s) => s.storyId);
    const triggered = stories.find(
      (s) => s.storyId === storyId || platformStoryId(s) === storyId,
    );
    if (!triggered?.componentPath) {
      const keys = keysFor([storyId]);
      return keys.length > 0 ? keys : [storyId];
    }

    const matched = await resolveAffectedFromPaths(stories, [triggered.componentPath], {
      projectRoot: this.opts.projectRoot,
      buildDir: this.opts.buildDir,
    });

    // Siblings can opt out of live recapture: a long play function or a
    // deliberate delay makes a keystroke-triggered capture cost more than it
    // returns. The story on screen is always captured — the developer is
    // looking at it, and it may not appear in the graph walk at all if the
    // manifest never recorded its file.
    //
    // Scheduling happens before any page exists, so this reads the enumerated
    // params. On Storybook those come from the static index, which does not
    // serialize `parameters.juxtapose` — so the opt-out is honoured on Ladle
    // today and on Storybook once #12 lands. It never over-captures: an
    // unreadable param leaves the story in, which is the status quo.
    const result = keysFor(watchTargets(storyId, matched));
    this.affectedCache.set(storyId, result);
    return result;
  }

  async image(kind: ImageKind, storyId: string): Promise<Buffer | null> {
    if (kind === 'baseline') return this.opts.store.get(storyId);
    return this.readImage(kind, storyId);
  }

  async handoff(storyId: string): Promise<string | null> {
    const report = await this.loadReport();
    const result = report?.results.find((r) => r.storyId === storyId);
    if (!result) return null;

    // The source is the story's; a variant has no file of its own. The index
    // has the title and path, and the result says what the variant set, so
    // no discovery (and no browser) is needed for a prompt.
    const baseId = result.baseStoryId ?? storyId;
    const story = (await this.indexStories()).find((s) => s.storyId === baseId);
    const variant = handoffVariant(result);
    const images = path.join(this.opts.runDir, 'images');
    const safe = encodeStoryId(storyId);
    const baseline = this.locateBaseline(storyId);

    return buildHandoffPrompt({
      storyId,
      storyTitle: story ? `${story.title} — ${story.name}` : storyId,
      status: result.status,
      mismatchPercent: result.mismatchPercent,
      mismatchPixels: result.mismatchPixels,
      changedRegions: result.changedRegions,
      // What the capture was taken at, which changedRegions are relative to;
      // a variant's viewport is not its story's.
      viewport:
        result.viewport ??
        story?.params.viewport ??
        this.opts.config.viewport ??
        DEFAULT_VIEWPORT,
      componentPath: story?.componentPath ?? '',
      images: {
        baseline,
        current: path.join(images, `${safe}-current.webp`),
        diff:
          result.status === 'fail' ? path.join(images, `${safe}-diff.webp`) : undefined,
      },
      projectRoot: this.opts.projectRoot,
      ...(variant ? { variant } : {}),
    });
  }

  /**
   * The baseline image on disk, as `jux handoff` finds it.
   *
   * Baselines live in the store, not the run dir: a run writes only what it
   * captured. The handoff used to point at `images/<id>-baseline.webp` in the
   * run dir, which nothing writes (#115). A variant key locates the variant's
   * own baseline. Absent when the store cannot say or there is no baseline
   * yet, so the prompt never names a file that is not there.
   */
  private locateBaseline(storyId: string): string | undefined {
    let file: string | undefined;
    try {
      file = this.opts.store.locate?.(storyId);
    } catch {
      return undefined;
    }
    return file !== undefined && existsSync(file) ? file : undefined;
  }

  async approve(storyId: string): Promise<void> {
    const task = this.approvalQueue.then(async () => {
      const image = await this.readImage('current', storyId);
      if (!image) throw new Error(`no capture for ${storyId} in the last run`);
      const { structureError } = await approveCapture(
        this.opts.store,
        storyId,
        image,
        {
          commit: this.opts.commitSha,
          approvedBy: process.env.JUXTAPOSE_USER ?? process.env.USER ?? 'unknown',
          approvedAt: new Date().toISOString(),
          // The run that produced this capture, not the addon process. Approving
          // through the panel must record the same fingerprint the CLI would.
          env: this.report?.env,
        },
        this.imagePath('current', storyId),
      );
      // Approved either way: structure never decides a story's status.
      if (structureError) {
        process.stderr.write(
          `juxtapose: approved ${storyId}, but its structure was not saved: ${structureError}\n`,
        );
      }
    });
    // Keep the chain alive even if this link rejects, or one failed approval
    // would wedge every subsequent one.
    this.approvalQueue = task.catch(() => {});
    await task;
  }

  async run(storyIds?: string[]): Promise<void> {
    if (this.running) return;

    const all = await this.stories();
    // A base id runs the story with all its variants; a key, one capture.
    const selected = storyIds?.length ? selectByStoryId(all, storyIds).selected : all;

    this.running = true;
    this.done = 0;
    this.total = selected.length;
    this.currentStory = null;
    this.abort = new AbortController();

    try {
      const browser = await this.ensureBrowser();
      const report = await runCapture({
        browser,
        platform: this.opts.platform,
        store: this.opts.store,
        baseUrl: this.opts.baseUrl,
        stories: selected,
        totalCount: all.length,
        config: this.opts.config,
        ancestry: existsSync(path.join(this.opts.projectRoot, '.git'))
          ? createAncestryCheck(this.opts.projectRoot)
          : alwaysAncestor,
        runId: Date.now().toString(36),
        branch: this.opts.branch,
        commitSha: this.opts.commitSha,
        signal: this.abort.signal,
        onProgress: (done, total, storyId) => {
          this.done = done;
          this.total = total;
          this.currentStory = storyId;
        },
        onArtifact: async (a) => {
          const images = path.join(this.opts.runDir, 'images');
          await mkdir(images, { recursive: true });
          const safe = encodeStoryId(a.storyId);
          await writeFile(path.join(images, `${safe}-current.webp`), a.current);
          if (a.diff) await writeFile(path.join(images, `${safe}-diff.webp`), a.diff);
        },
      });

      // A partial run only re-captured some stories; merging keeps the others
      // visible instead of blanking the panel down to the subset.
      this.report = storyIds?.length ? mergeReports(this.report, report) : report;
      await mkdir(this.opts.runDir, { recursive: true });
      await writeFile(
        path.join(this.opts.runDir, 'report.json'),
        JSON.stringify(this.report, null, 2) + '\n',
      );
    } finally {
      this.running = false;
      this.currentStory = null;
      this.abort = null;
    }
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  private async ensureBrowser(): Promise<Browser> {
    // Kept alive across runs: launching Chromium is most of the latency on a
    // single-story recapture, which is the common case in the panel.
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await acquireBrowser();
    return this.browser;
  }

  private async loadReport(): Promise<RunReport | null> {
    if (this.report) return this.report;
    try {
      const raw = await readFile(path.join(this.opts.runDir, 'report.json'), 'utf8');
      this.report = parseRunReport(raw);
    } catch {
      this.report = null;
    }
    return this.report;
  }

  private imagePath(kind: 'current' | 'diff', storyId: string): string {
    return path.join(
      this.opts.runDir,
      'images',
      `${encodeStoryId(storyId)}-${kind}.webp`,
    );
  }

  private async readImage(
    kind: 'current' | 'diff',
    storyId: string,
  ): Promise<Buffer | null> {
    const file = this.imagePath(kind, storyId);
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }
}

/** Overlay fresh results onto the previous report, keeping untouched stories. */
export function mergeReports(previous: RunReport | null, fresh: RunReport): RunReport {
  if (!previous) return fresh;

  const byId = new Map(previous.results.map((r) => [r.storyId, r]));
  for (const result of fresh.results) byId.set(result.storyId, result);

  const results = [...byId.values()].sort((a, b) =>
    compareCodeUnits(a.storyId, b.storyId),
  );
  const summary = { pass: 0, fail: 0, new: 0, stale: 0, skip: 0 };
  for (const r of results) summary[r.status]++;

  // Groups span stories, so a partial run's groups are stale the moment it
  // is merged: recompute over the merged results.
  const { groups: _stale, ...rest } = fresh;
  const groups = computeGroups(results);
  return {
    ...rest,
    results,
    summary,
    ...(groups.length > 0 ? { groups } : {}),
    totalCount: previous.totalCount,
  };
}

/** The same hash the manifest stores, so a match means "already approved". */

/** Modification times of every file a project config can come from. A
 *  changed stamp means the user edited it, so a cached config error is
 *  worth retrying. */
function configStamp(projectRoot: string): string {
  return ['juxtapose.config.json', '.juxtaposerc.json', 'package.json']
    .map((name) => {
      try {
        return String(statSync(path.join(projectRoot, name)).mtimeMs);
      } catch {
        return '-';
      }
    })
    .join('|');
}
