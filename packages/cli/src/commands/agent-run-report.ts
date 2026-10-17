import { readFile, realpath, stat } from 'node:fs/promises';
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

/** Bounded MCP overview. Full evidence remains in the saved report. */
export function agentRunSummary(report: RunReport) {
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
    ...(groups.length
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
