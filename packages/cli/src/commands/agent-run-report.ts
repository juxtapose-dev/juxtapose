import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseRunReport, type DiffResult, type RunReport } from '@juxtapose/core';
import { latestRunDir } from '../run-dir.js';

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

/** Parsed reports are shared by repeated story/full lookups in one MCP session. */
export class SavedReportCache {
  private readonly reports = new Map<
    string,
    {
      signature: string;
      report: RunReport;
      byStory: Map<string, DiffResult>;
      summary: ReturnType<typeof agentRunSummary>;
    }
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
    const report = parseRunReport(await readFile(file, 'utf8'), file);
    this.reports.delete(file);
    const entry = {
      signature,
      report,
      byStory: new Map(report.results.map((result) => [result.storyId, result])),
      summary: agentRunSummary(report),
    };
    this.reports.set(file, entry);
    if (this.reports.size > MAX_CACHED_REPORTS)
      this.reports.delete(this.reports.keys().next().value!);
    return entry;
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
export function observedChanges(results: DiffResult[]): string[] {
  const failing = results.filter(
    (r) => r.status === 'fail' && !r.error && r.structural?.deltas.length,
  );
  const minimum = failing.length <= SINGLE_CAPTURE_LIMIT ? 1 : 2;
  const found = new Map<string, { style: boolean; ids: string[] }>();
  for (const r of failing) {
    const own = new Set<string>();
    for (const d of r.structural!.deltas) {
      const el = 'el' in d ? d.el.replace(/ \(\d+(?:st|nd|rd|th)\)$/, '') : '';
      let text: string;
      if (d.kind === 'style') text = `${el} ${d.prop} ${hex(d.from)}→${hex(d.to)}`;
      else if (d.kind === 'resized' && !CONTAINER_LABELS.has(el))
        text = `${el} resized ${[d.dw && `w${px(d.dw)}`, d.dh && `h${px(d.dh)}`]
          .filter(Boolean)
          .join(' ')}px`;
      else continue;
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
  const lines = listed.slice(0, MAX_CHANGES).map(([text, e]) => {
    const where =
      e.ids.length === failing.length
        ? `all ${failing.length}`
        : e.ids.length <= 2
          ? e.ids.join(', ')
          : `${e.ids.length}/${failing.length}`;
    return `${text} (${where})`;
  });
  if (listed.length > MAX_CHANGES) lines.push(`+${listed.length - MAX_CHANGES} more`);
  return lines;
}

/** Bounded MCP overview. Full evidence remains in the saved report. */
export function agentRunSummary(report: RunReport) {
  const changes = observedChanges(report.results);
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
    durationMs: report.durationMs,
    recheck: report.recheck,
    // The deduplicated facts subsume the truncated group lines, so only one
    // of the two is sent.
    ...(changes.length
      ? { changesFromApproved: changes }
      : groups.length
        ? { groups, omittedGroups: Math.max(0, (report.groups?.length ?? 0) - 3) }
        : {}),
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
    next: onlyStaleAttention
      ? 'These stale captures match saved baseline bytes. Their approval commits are outside current branch ancestry; no visual edit, detailed report, or recapture is needed. Re-approval is a separate decision to re-anchor the baselines.'
      : 'Call report with story for one full result, or detail=full for the saved RunReport. No recapture is needed.',
  };
}
