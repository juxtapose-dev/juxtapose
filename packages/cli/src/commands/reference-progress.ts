import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseRunReport, type DesignReferenceLedger } from '@juxtapose/core';
import { isRecord } from '../guards.js';
import { savedRunReportPath, recentSavedRunIds } from './agent-run-report.js';
import { evaluateReferences, type ReferenceResult } from './reference.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const usable = (state: { status: string; mismatchPixels?: number | null }) =>
  (state.status === 'pass' || state.status === 'fail') &&
  typeof state.mismatchPixels === 'number' &&
  Number.isFinite(state.mismatchPixels) &&
  state.mismatchPixels >= 0;

function identity(ledger: DesignReferenceLedger): string {
  return JSON.stringify([
    ledger.name,
    ledger.storyId,
    ledger.referenceHash,
    ledger.geometry,
    ledger.policy,
  ]);
}

/** Four cleaned controls already solved Billing in one edit. Keep history
 * opt-in until post-edit decision replays show it saves another model call.
 * Read saved analyses for at most 20 runs; only the immediate previous run
 * may need a missing analysis filled through the existing content cache. */
export async function targetProgress(
  project: string,
  current: ReferenceResult,
  previousRun?: string,
): Promise<void> {
  const states = current.states.filter(
    (state): state is Extract<ReferenceResult['states'][number], { geometry: unknown }> =>
      usable(state),
  );
  if (!states.length) return;
  const wanted = new Map(states.map((state) => [identity(state), state]));
  const history = await recentSavedRunIds(project);
  const runs = history.runIds.filter((runId) => runId !== current.runId).slice(0, 19);
  const ledgers = new Map<string, Map<string, DesignReferenceLedger>>();
  for (const run of runs) {
    ledgers.set(run, await readLedgers(project, run, wanted));
  }
  if (previousRun && previousRun !== current.runId && runs.includes(previousRun)) {
    const previous = ledgers.get(previousRun)!;
    if (states.some((state) => !previous.has(identity(state)))) {
      // One batch, not one comparison per target. Existing valid ledgers are
      // reused by compareDesignReference without decoding/diffing again.
      const result = await evaluateReferences({ project, run: previousRun }).catch(
        () => undefined,
      );
      for (const state of result?.states ?? []) {
        if (state.status !== 'error' && usable(state) && wanted.has(identity(state)))
          previous.set(identity(state), state);
      }
    }
  }
  for (const state of states) {
    const key = identity(state);
    const previous = previousRun ? ledgers.get(previousRun)?.get(key) : undefined;
    if (previous?.mismatchPixels !== undefined && previous.mismatchPixels !== null) {
      const before = previous.mismatchPixels;
      const now = state.mismatchPixels!;
      state.progress = {
        fromRun: previousRun!,
        pixels: [before, now],
        trend: now < before ? 'closer' : now > before ? 'further' : 'same',
      };
    }
    let best = { runId: current.runId, pixels: state.mismatchPixels! };
    for (const run of runs) {
      const candidate = ledgers.get(run)?.get(key);
      if (
        candidate?.mismatchPixels !== undefined &&
        candidate.mismatchPixels !== null &&
        candidate.mismatchPixels < best.pixels
      )
        best = { runId: run, pixels: candidate.mismatchPixels };
    }
    state.bestRun = best.runId;
  }
}

async function readLedgers(
  project: string,
  runId: string,
  wanted: Map<string, unknown>,
): Promise<Map<string, DesignReferenceLedger>> {
  const found = new Map<string, DesignReferenceLedger>();
  try {
    const report = await savedRunReportPath(project, runId);
    const captures = new Map(
      parseRunReport(await readFile(report, 'utf8')).results.map((r) => [r.storyId, r]),
    );
    const dir = path.join(path.dirname(report), 'reference-analysis-v1');
    if (!(await lstat(dir)).isDirectory() || (await realpath(dir)) !== dir) return found;
    for (const file of (await readdir(dir)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const full = path.join(dir, file);
      const info = await lstat(full);
      if (!info.isFile() || info.size > 1024 * 1024) continue;
      try {
        const entry: unknown = JSON.parse(await readFile(full, 'utf8'));
        if (!isRecord(entry) || !isRecord(entry['ledger'])) continue;
        const ledger = entry['ledger'] as unknown as DesignReferenceLedger;
        if (
          entry['version'] !== 1 ||
          !ledger ||
          ledger.comparisonId !== file.slice(0, -5) ||
          entry['checksum'] !== hash(JSON.stringify(ledger)) ||
          !usable(ledger) ||
          !wanted.has(identity(ledger))
        )
          continue;
        const capture = captures.get(ledger.storyId);
        if (
          !capture ||
          capture.error ||
          capture.status === 'skip' ||
          !capture.hash ||
          capture.hash !== ledger.currentHash
        )
          continue;
        found.set(identity(ledger), ledger);
      } catch {
        // A missing/corrupt derived analysis contributes no progress evidence.
      }
    }
  } catch {
    // Older runs need not have reference analysis.
  }
  return found;
}
