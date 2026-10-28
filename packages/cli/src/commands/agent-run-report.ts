import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseRunReport, type DiffResult, type RunReport } from '@juxtapose/core';
import { latestRunDir } from '../run-dir.js';
import { controlGeometrySummary } from './control-geometry-summary.js';

interface SummaryOptions {
  designReferencesCompared?: boolean;
  /** Internal benchmark override; selective measurements are enabled by default. */
  controlMeasurements?: boolean;
}

const MAX_STORIES = 8;
const MAX_CACHED_REPORTS = 8;

function inside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Only reports in direct children of this project's runs directory are readable. */
export async function savedRunReportPath(
  project: string,
  runId?: string,
): Promise<string> {
  const root = await realpath(path.join(project, '.juxtapose', 'runs')).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error('jux: no saved run found. Call the run tool first.');
      throw error;
    },
  );
  if (!inside(root, await realpath(project)))
    throw new Error('jux: saved runs directory must remain inside the project');
  if (runId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(runId))
    throw new Error('jux: runId must be a saved run ID');
  const candidate = runId ? path.join(root, runId) : await latestRunDir(project);
  if (!candidate) throw new Error('jux: no saved run found. Call the run tool first.');
  const dir = await realpath(candidate);
  if (path.dirname(dir) !== root)
    throw new Error('jux: runId must select a saved project run');
  const file = await realpath(path.join(dir, 'report.json'));
  if (!inside(file, dir)) throw new Error('jux: run report escapes the saved run');
  return file;
}

const MAX_LISTED_RUNS = 20;

/** Saved runs newest first, so an agent can pick a checkpoint without having
 *  kept every run ID. Only the newest reports are parsed; runs are never
 *  pruned, so the directory can hold hundreds. */
export async function recentSavedRunIds(project: string) {
  const root = path.join(project, '.juxtapose', 'runs');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dated = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
      .map(async (entry) => {
        const file = path.join(root, entry.name, 'report.json');
        const info = await stat(file).catch(() => null);
        return info ? { runId: entry.name, file, mtime: info.mtimeMs } : null;
      }),
  );
  const runs = dated
    .filter((run): run is NonNullable<typeof run> => run !== null)
    .sort(
      (a, b) => b.mtime - a.mtime || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
    );
  return {
    runIds: runs.slice(0, MAX_LISTED_RUNS).map((run) => run.runId),
    omitted: Math.max(0, runs.length - MAX_LISTED_RUNS),
  };
}

export async function savedRuns(project: string) {
  const { runIds, omitted } = await recentSavedRunIds(project);
  const listed = await Promise.all(
    runIds.map(async (runId) => {
      try {
        // The same containment checks as a report lookup: no symlinked escape.
        const file = await savedRunReportPath(project, runId);
        const report = parseRunReport(await readFile(file, 'utf8'), file);
        return {
          runId: report.runId,
          startedAt: report.startedAt,
          capturedCount: report.capturedCount,
          summary: report.summary,
        };
      } catch {
        return { runId, error: 'report unreadable' };
      }
    }),
  );
  return {
    schema: 'juxtapose.saved-runs/v1',
    runs: listed,
    omitted,
  };
}

type CachedReport = {
  signature: string;
  report: RunReport;
  byStory: Map<string, DiffResult>;
  summary: ReturnType<typeof agentRunSummary>;
};

/** Parsed reports are shared by repeated story/full lookups in one MCP session. */
export class SavedReportCache {
  constructor(private readonly options: SummaryOptions = {}) {}
  private readonly reports = new Map<string, CachedReport>();
  private readonly pending = new Map<
    string,
    { signature: string; load: Promise<CachedReport> }
  >();

  private async entry(project: string, runId?: string) {
    const file = await savedRunReportPath(project, runId);
    const info = await stat(file);
    const signature = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const cached = this.reports.get(file);
    if (cached?.signature === signature) {
      this.reports.delete(file);
      this.reports.set(file, cached);
      return cached;
    }
    const pending = this.pending.get(file);
    if (pending?.signature === signature) return pending.load;
    // Three simultaneous element queries read/parsed the same report three
    // times on a cold cache. Share that work as well as the structure sidecar.
    const load: Promise<CachedReport> = readFile(file, 'utf8').then((raw) => {
      const report = parseRunReport(raw, file);
      const entry = {
        signature,
        report,
        byStory: new Map(report.results.map((result) => [result.storyId, result])),
        summary: agentRunSummary(report, this.options),
      };
      // An older in-flight read must not replace a newer file revision.
      if (this.pending.get(file)?.load === load) {
        this.reports.delete(file);
        this.reports.set(file, entry);
        if (this.reports.size > MAX_CACHED_REPORTS)
          this.reports.delete(this.reports.keys().next().value!);
      }
      return entry;
    });
    this.pending.set(file, { signature, load });
    try {
      return await load;
    } finally {
      if (this.pending.get(file)?.load === load) this.pending.delete(file);
    }
  }

  async get(project: string, runId?: string): Promise<RunReport> {
    return (await this.entry(project, runId)).report;
  }

  async story(project: string, story: string, runId?: string) {
    const { report, byStory } = await this.entry(project, runId);
    return { report, result: byStory.get(story) };
  }

  async summary(project: string, runId?: string) {
    return (await this.entry(project, runId)).summary;
  }
}

function priority(result: DiffResult): number {
  if (result.error) return 0;
  if (result.unstable && !result.unrechecked) return 1;
  if (result.status === 'fail') return 2;
  if (result.status === 'new') return 3;
  if (result.status === 'stale') return 4;
  return 5;
}

const MAX_CHANGES = 6;
const MAX_CHANGE_BYTES = 800;
/** Up to this many failing captures, a change seen in one is still listed:
 *  it is usually a different viewport or state of the same page (a mobile-only
 *  grid). Beyond it, single-capture changes are noise a handoff can name. */
const SINGLE_CAPTURE_LIMIT = 8;
/** Page containers resize with every reflow; naming them repeats the consequence. */
const CONTAINER_LABELS = new Set(['main', 'body', 'html']);

const hex = (value: string) =>
  value.replace(/rgb\((\d+), (\d+), (\d+)\)/g, (_, r: string, g: string, b: string) =>
    [r, g, b].reduce((out, c) => out + Number(c).toString(16).padStart(2, '0'), '#'),
  );
const px = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** Observed approved→current facts, deduplicated across the failing captures:
 *  changed computed properties, and resizes that repeat. Each verdict stores a
 *  budgeted prefix of its deltas, so a count is "listed in", not "affected".
 *  It states what the structure sidecars measured, not which rule caused it. */
function observedChangeSummary(results: DiffResult[]) {
  let omittedLongObservations = 0;
  const failing = results.filter(
    (r) => r.status === 'fail' && !r.error && r.structural?.deltas.length,
  );
  const minimum = failing.length <= SINGLE_CAPTURE_LIMIT ? 1 : 2;
  const found = new Map<string, { style: boolean; ids: string[] }>();
  for (const r of failing) {
    const own = new Set<string>();
    for (const d of r.structural!.deltas) {
      const el = 'el' in d ? d.el : '';
      let text: string;
      if (d.kind === 'style') text = `${el} ${d.prop} ${hex(d.from)}→${hex(d.to)}`;
      else if (d.kind === 'resized' && !CONTAINER_LABELS.has(el))
        text = `${el} resized ${[d.dw && `w${px(d.dw)}`, d.dh && `h${px(d.dh)}`]
          .filter(Boolean)
          .join(' ')}px`;
      else continue;
      // Keep a measurement intact; long selectors/values belong in the saved result.
      if (text.length > 240) {
        omittedLongObservations++;
        continue;
      }
      if (own.has(text)) continue;
      own.add(text);
      const entry = found.get(text) ?? { style: d.kind === 'style', ids: [] };
      entry.ids.push(r.storyId);
      found.set(text, entry);
    }
  }
  const listed = [...found]
    .filter(([, e]) => e.ids.length >= (e.style ? minimum : 2))
    .sort(
      ([ta, a], [tb, b]) =>
        Number(b.style) - Number(a.style) ||
        b.ids.length - a.ids.length ||
        (ta < tb ? -1 : ta > tb ? 1 : 0),
    );
  const lines: string[] = [];
  let omitted = 0;
  for (const [text, e] of listed) {
    const where =
      e.ids.length === failing.length
        ? `all ${failing.length}`
        : e.ids.length <= 2
          ? e.ids.join(', ')
          : `${e.ids.length}/${failing.length}`;
    const line = `${text} (${where})`;
    // Reserve 32 bytes for the omission marker, including JSON punctuation.
    if (
      lines.length < MAX_CHANGES &&
      Buffer.byteLength(JSON.stringify([...lines, line])) <= MAX_CHANGE_BYTES - 32
    )
      lines.push(line);
    else omitted++;
  }
  if (omitted) lines.push(`+${omitted} more`);
  return { lines, omittedLongObservations };
}

export function observedChanges(results: DiffResult[]): string[] {
  return observedChangeSummary(results).lines;
}

/** Bounded MCP overview. Full evidence remains in the saved report. */
export function agentRunSummary(report: RunReport, options: SummaryOptions = {}) {
  const controlMeasurements =
    options.controlMeasurements !== false
      ? controlGeometrySummary(report.results)
      : undefined;
  const { lines: changes, omittedLongObservations } = observedChangeSummary(
    report.results,
  );
  const captured = report.results.filter((r) => r.status !== 'skip');
  // No approved baseline exists for any captured story, so a baseline verdict
  // says nothing; the design targets are the only comparison this run made.
  const targetsOnly =
    options.designReferencesCompared === true &&
    captured.length > 0 &&
    captured.every((r) => r.status === 'new');
  const attention = report.results.filter((r) => priority(r) < 5);
  const onlyStaleAttention =
    attention.length > 0 &&
    attention.every((result) => priority(result) === 4 && !result.unstable);
  attention.sort(
    (a, b) => priority(a) - priority(b) || a.storyId.localeCompare(b.storyId),
  );
  const groups = [...(report.groups ?? [])]
    .sort((a, b) => b.storyIds.length - a.storyIds.length)
    .slice(0, 3)
    .map((group) => ({
      summary: group.summary.slice(0, 160),
      count: group.storyIds.length,
    }));
  return {
    schema: 'juxtapose.agent-run/v1',
    runId: report.runId,
    capturedCount: report.capturedCount,
    totalCount: report.totalCount,
    summary: report.summary,
    recheck: report.recheck,
    ...(controlMeasurements ? { controlMeasurements } : {}),
    // The deduplicated facts subsume the truncated group lines, so only one
    // of the two is sent.
    ...(changes.length
      ? {
          changesFromApproved: changes,
          evidence:
            'structure; approved→current; saved element labels, not guaranteed unique CSS selectors or CSS causes',
        }
      : groups.length
        ? { groups, omittedGroups: Math.max(0, (report.groups?.length ?? 0) - 3) }
        : {}),
    ...(omittedLongObservations ? { omittedLongObservations } : {}),
    attention: attention.slice(0, MAX_STORIES).map((r) => ({
      storyId: r.storyId,
      status: r.status,
      ...(r.error ? { error: r.error.slice(0, 240) } : {}),
      ...(r.unstable ? { stability: r.unrechecked ? 'unrechecked' : 'unstable' } : {}),
      ...(r.rendererRetry ? { rendererRetry: r.rendererRetry.outcome } : {}),
      ...(r.status === 'fail' ? { mismatchPercent: r.mismatchPercent } : {}),
    })),
    omittedAttention: Math.max(0, attention.length - MAX_STORIES),
    ...(attention.some((result) => result.status === 'stale') && !onlyStaleAttention
      ? {
          staleMeaning:
            'Stale baseline image bytes match; the approval commit is outside current branch ancestry.',
        }
      : {}),
    next: targetsOnly
      ? 'No approved baseline; use the design-reference hint below for target mismatches.'
      : onlyStaleAttention
        ? 'Baseline bytes match; approval commits are outside current branch ancestry; no visual edit, detailed report, or recapture is needed. Re-approval only re-anchors baselines.'
        : attention.length === 0
          ? 'No listed blockers. Stop only after required capture coverage, target comparisons and behavior checks pass.'
          : 'Use returned facts. report(story, runId) only for missing baseline detail; these are not design-target instructions. No recapture.',
  };
}
