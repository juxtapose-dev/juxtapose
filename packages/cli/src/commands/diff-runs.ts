// `jux diff --runs <a> <b>` — are two runs byte-identical, story by story?
//
// Determinism is the product, so "did these two runs capture the same pixels"
// is a first-class question. It is answered from the `hash` each report.json
// result carries: no browser, no decode.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  compareCodeUnits,
  encodeStoryId,
  hashImage,
  parseRunReport,
  shellQuote,
  type DiffResult,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
import { errorMessage } from '../guards.js';
import type { Io } from '../io.js';

export interface RunsFlags {
  json?: boolean;
  project?: string;
}

export interface RunSide {
  /** The run id, i.e. the directory's basename. */
  runId: string;
  /** story id -> sha256 of the current capture, or `<status>` when nothing was
   *  captured (skip, capture error) so two skipped stories still compare equal. */
  hashes: Map<string, string>;
}

export interface RunsComparison {
  identical: string[];
  different: string[];
  /** Stories present in only one run; `in` names the run that has it. */
  missing: Array<{ storyId: string; in: 'a' | 'b' }>;
}

/** A run id under .juxtapose/runs, or a path to a run directory. */
export function resolveRunDir(projectRoot: string, ref: string): string | null {
  const asPath = path.resolve(projectRoot, ref);
  if (existsSync(path.join(asPath, 'report.json'))) return asPath;
  const byId = path.join(projectRoot, '.juxtapose', 'runs', ref);
  return existsSync(path.join(byId, 'report.json')) ? byId : null;
}

/** The hash a result carries, or, for a report written before `hash` existed,
 *  one computed from the run's own image. */
async function resultHash(runDir: string, r: DiffResult): Promise<string> {
  if (r.hash) return r.hash;
  try {
    return hashImage(
      await readFile(
        path.join(runDir, 'images', `${encodeStoryId(r.storyId)}-current.webp`),
      ),
    );
  } catch {
    return `<${r.status}>`;
  }
}

async function readRun(runDir: string): Promise<RunSide> {
  const report = parseRunReport(
    await readFile(path.join(runDir, 'report.json'), 'utf8'),
    path.join(runDir, 'report.json'),
  );
  const hashes = new Map<string, string>();
  for (const r of report.results) hashes.set(r.storyId, await resultHash(runDir, r));
  return { runId: path.basename(runDir), hashes };
}

export function compareRuns(a: RunSide, b: RunSide): RunsComparison {
  const out: RunsComparison = { identical: [], different: [], missing: [] };
  const ids = [...new Set([...a.hashes.keys(), ...b.hashes.keys()])].sort(
    compareCodeUnits,
  );
  for (const storyId of ids) {
    const ha = a.hashes.get(storyId);
    const hb = b.hashes.get(storyId);
    if (ha === undefined) out.missing.push({ storyId, in: 'b' });
    else if (hb === undefined) out.missing.push({ storyId, in: 'a' });
    else (ha === hb ? out.identical : out.different).push(storyId);
  }
  return out;
}

export async function diffRuns(
  a: string,
  b: string,
  flags: RunsFlags,
  io: Io,
): Promise<number> {
  const root = path.resolve(flags.project ?? process.cwd());
  const dirs: string[] = [];
  for (const ref of [a, b]) {
    const dir = resolveRunDir(root, ref);
    if (!dir) {
      io.err(
        `jux diff: no run '${ref}' (no report.json at that path or in ${path.join(root, '.juxtapose', 'runs')}). Run \`jux run\` first, or pass a run directory.\n`,
      );
      return EXIT.usage;
    }
    dirs.push(dir);
  }
  let sides: RunSide[];
  try {
    sides = await Promise.all(dirs.map(readRun));
  } catch (err) {
    io.err(
      `jux diff: cannot read a run report (${errorMessage(err)}). Re-run with \`jux run\`.\n`,
    );
    return EXIT.failure;
  }
  const [sa, sb] = sides as [RunSide, RunSide];
  const c = compareRuns(sa, sb);
  const clean = c.different.length === 0 && c.missing.length === 0;
  if (flags.json) {
    io.out(
      JSON.stringify({
        schema: 'juxtapose.run-diff/v1',
        a: sa.runId,
        b: sb.runId,
        summary: {
          identical: c.identical.length,
          different: c.different.length,
          missing: c.missing.length,
        },
        different: c.different,
        missing: c.missing,
      }) + '\n',
    );
  } else {
    const lines = [
      `${shellQuote(sa.runId)} vs ${shellQuote(sb.runId)}: ${c.identical.length} identical, ${c.different.length} different` +
        (c.missing.length ? `, ${c.missing.length} in only one run` : ''),
    ];
    for (const id of c.different) lines.push(`  different  ${id}`);
    for (const m of c.missing)
      lines.push(`  only in ${m.in === 'a' ? sa.runId : sb.runId}  ${m.storyId}`);
    io.out(lines.join('\n') + '\n');
  }
  return clean ? EXIT.clean : EXIT.review;
}
