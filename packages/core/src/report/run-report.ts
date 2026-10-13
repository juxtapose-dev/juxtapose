// packages/core/src/report/run-report.ts
//
// Reading report.json back: `jux approve`, `check`, `handoff`, the MCP server
// and the review server all start from it.

import { isRecord } from '../browser/guards.js';
import type { RunReport } from '../types.js';

/**
 * What every reader dereferences before anything else: a results array whose
 * entries carry a string storyId. The rest of the report is trusted as `jux
 * run` wrote it; this catches the file that is not a report at all (truncated,
 * hand-edited, another tool's) with a message instead of a TypeError.
 */
export function isRunReport(v: unknown): v is RunReport {
  return (
    isRecord(v) &&
    Array.isArray(v['results']) &&
    v['results'].every((r) => isRecord(r) && typeof r['storyId'] === 'string')
  );
}

/** JSON.parse plus isRunReport; throws, naming `source`, on either failure. */
export function parseRunReport(text: string, source = 'report.json'): RunReport {
  const parsed: unknown = JSON.parse(text);
  if (!isRunReport(parsed))
    throw new Error(`jux: ${source} is not a run report (no results with story ids)`);
  return parsed;
}
