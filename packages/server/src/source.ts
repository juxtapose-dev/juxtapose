// A ReviewSource backed by run artifacts on disk plus a live capture pool.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import {
  buildHandoffPrompt,
  createAncestryCheck,
  alwaysAncestor,
  deterministicLaunchOptions,
  encodeStoryId,
  runCapture,
  DEFAULT_VIEWPORT,
  type BaselineStore,
  type Platform,
  type ProjectConfig,
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
}

export class RunDirSource implements ReviewSource {
  private report: RunReport | null = null;
  private storyCache: StoryManifest[] | null = null;
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
    (this.opts as { baseUrl: string }).baseUrl = baseUrl;
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
      if (current && hash(current) === entry.hash) approved.push(result.storyId);
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

  async stories(): Promise<StoryManifest[]> {
    if (this.storyCache) return this.storyCache;
    this.storyCache = await this.opts.platform.enumerate({
      projectRoot: this.opts.projectRoot,
      origin: this.opts.baseUrl,
    });
    return this.storyCache;
  }

  /** Drop the cached story index — the workbench told us it changed. */
  flushStories(): void {
    this.storyCache = null;
  }

  async image(kind: ImageKind, storyId: string): Promise<Buffer | null> {
    if (kind === 'baseline') return this.opts.store.get(storyId);
    return this.readImage(kind, storyId);
  }

  async handoff(storyId: string): Promise<string | null> {
    const report = await this.loadReport();
    const result = report?.results.find((r) => r.storyId === storyId);
    if (!result) return null;

    const story = (await this.stories()).find((s) => s.storyId === storyId);
    const images = path.join(this.opts.runDir, 'images');
    const safe = encodeStoryId(storyId);

    return buildHandoffPrompt({
      storyId,
      storyTitle: story ? `${story.title} — ${story.name}` : storyId,
      status: result.status,
      mismatchPercent: result.mismatchPercent,
      mismatchPixels: result.mismatchPixels,
      changedRegions: result.changedRegions,
      viewport: story?.params.viewport ?? this.opts.config.viewport ?? DEFAULT_VIEWPORT,
      componentPath: story?.componentPath ?? '',
      images: {
        baseline: path.join(images, `${safe}-baseline.webp`),
        current: path.join(images, `${safe}-current.webp`),
        diff:
          result.status === 'fail' ? path.join(images, `${safe}-diff.webp`) : undefined,
      },
      projectRoot: this.opts.projectRoot,
    });
  }

  async approve(storyId: string): Promise<void> {
    const task = this.approvalQueue.then(async () => {
      const image = await this.readImage('current', storyId);
      if (!image) throw new Error(`no capture for ${storyId} in the last run`);
      await this.opts.store.put(storyId, image, {
        commit: this.opts.commitSha,
        approvedBy: process.env.JUXTAPOSE_USER ?? process.env.USER ?? 'unknown',
        approvedAt: new Date().toISOString(),
      });
    });
    // Keep the chain alive even if this link rejects, or one failed approval
    // would wedge every subsequent one.
    this.approvalQueue = task.catch(() => {});
    await task;
  }

  async run(storyIds?: string[]): Promise<void> {
    if (this.running) return;

    const all = await this.stories();
    const selected = storyIds?.length
      ? all.filter((s) => storyIds.includes(s.storyId))
      : all;

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
    this.browser = await chromium.launch(deterministicLaunchOptions());
    return this.browser;
  }

  private async loadReport(): Promise<RunReport | null> {
    if (this.report) return this.report;
    try {
      const raw = await readFile(path.join(this.opts.runDir, 'report.json'), 'utf8');
      this.report = JSON.parse(raw) as RunReport;
    } catch {
      this.report = null;
    }
    return this.report;
  }

  private async readImage(
    kind: 'current' | 'diff',
    storyId: string,
  ): Promise<Buffer | null> {
    const file = path.join(
      this.opts.runDir,
      'images',
      `${encodeStoryId(storyId)}-${kind}.webp`,
    );
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  }
}

/** Overlay fresh results onto the previous report, keeping untouched stories. */
function mergeReports(previous: RunReport | null, fresh: RunReport): RunReport {
  if (!previous) return fresh;

  const byId = new Map(previous.results.map((r) => [r.storyId, r]));
  for (const result of fresh.results) byId.set(result.storyId, result);

  const results = [...byId.values()].sort((a, b) => a.storyId.localeCompare(b.storyId));
  const summary = { pass: 0, fail: 0, new: 0, stale: 0, skip: 0 };
  for (const r of results) summary[r.status]++;

  return { ...fresh, results, summary, totalCount: previous.totalCount };
}

/** The same hash the manifest stores, so a match means "already approved". */
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
