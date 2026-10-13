// `jux diff <a> <b>` — the second half of the agent loop. Two snaps in, one
// tier-0 verdict out, no browser. Exit 0 identical, 1 different, 2 usage,
// 3 when an input exists but cannot be read.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  compareSnaps,
  decodeStructure,
  describeDeltas,
  type SnapSide,
  type StructuralVerdict,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
import { snapName } from '../snap-name.js';
import { snapsDir } from '../snaps-dir.js';

export interface DiffFlags {
  json?: boolean;
  project?: string;
  crops?: boolean;
}

export type ReadSnap =
  | { kind: 'ok'; side: SnapSide }
  | { kind: 'missing'; image: string }
  | { kind: 'corrupt'; file: string; error: string };

/** A snap by name (or by `.webp` path), with its sidecar. An absent sidecar
 *  is fine — the verdict degrades and says so. A sidecar that exists and will
 *  not decode is a tool failure: it is not something the agent can reason
 *  around, so it is reported as one rather than silently dropped. */
export async function readSnap(dir: string, ref: string): Promise<ReadSnap> {
  // An explicit .webp path is deliberately unconfined: it is the user's own
  // argument on their own machine, not a name derived into a snaps/ path.
  const image = ref.endsWith('.webp')
    ? path.resolve(ref)
    : path.join(dir, `${snapName(ref, ref)}.webp`);
  const bytes = await readFile(image).catch(() => null);
  if (!bytes) return { kind: 'missing', image };
  const sidecar = image.replace(/\.webp$/, '.structure.json.gz');
  const gz = await readFile(sidecar).catch(() => null);
  if (!gz) return { kind: 'ok', side: { image: bytes } };
  try {
    return { kind: 'ok', side: { image: bytes, structure: decodeStructure(gz) } };
  } catch (err) {
    return { kind: 'corrupt', file: sidecar, error: (err as Error).message };
  }
}

export function formatVerdict(v: StructuralVerdict): string {
  const lines = [v.summary];
  if (v.deltas.length > 0) {
    lines.push('', ...describeDeltas(v.deltas));
    // The JSON is capped by the same size budget, so it cannot list the rest.
    if (v.deltaCount > v.deltas.length)
      lines.push(`  …and ${v.deltaCount - v.deltas.length} more`);
  }
  if (v.flags.length) lines.push('', `flags: ${v.flags.join(', ')}`);
  if (v.classification !== 'identical')
    lines.push('', `next: ${v.escalate.command}  (opens the pixels)`);
  return lines.join('\n') + '\n';
}

export async function diffCommand(
  a: string | undefined,
  b: string | undefined,
  flags: DiffFlags,
): Promise<number> {
  if (!a || !b) {
    process.stderr.write(
      'jux diff: needs two snap names, e.g. `jux diff before after`. Take them with `jux snap <url> --as before` and `--as after`.\n',
    );
    return EXIT.usage;
  }
  if (flags.crops) {
    // Tier-3 crops land in a later release; until then name the pixels to open.
    const dir = snapsDir(flags.project);
    process.stderr.write(
      `jux diff: --crops is not available in this version; open the images instead:\n  ${path.join(dir, `${snapName(a, a)}.webp`)}\n  ${path.join(dir, `${snapName(b, b)}.webp`)}\n`,
    );
    return EXIT.usage;
  }
  try {
    return await diffTwo(a, b, flags);
  } catch (err) {
    // sharp failing to decode a .webp, or anything else unforeseen: a tool
    // failure, distinct from "different" so a script never approves on it.
    process.stderr.write(
      `jux diff: failed: ${(err as Error).message}. Re-take both snaps with \`jux snap <url> --as ${a}\` / \`--as ${b}\` and retry.\n`,
    );
    return EXIT.failure;
  }
}

/** Resolve both sides or explain which one is unusable and how to fix it. */
async function loadSides(
  dir: string,
  a: string,
  b: string,
): Promise<{ sides: [SnapSide, SnapSide] } | { code: number }> {
  const [ra, rb] = await Promise.all([readSnap(dir, a), readSnap(dir, b)]);
  for (const [ref, r] of [
    [a, ra],
    [b, rb],
  ] as const) {
    if (r.kind === 'missing') {
      process.stderr.write(
        ref.endsWith('.webp')
          ? `jux diff: no file at ${r.image}. Check the path, or take it with \`jux snap <url> --as <name>\`.\n`
          : `jux diff: no snap named '${ref}' in ${dir}. Run \`jux snap <url> --as ${ref}\` first.\n`,
      );
      return { code: EXIT.usage };
    }
    if (r.kind === 'corrupt') {
      process.stderr.write(
        `jux diff: cannot read ${r.file} (${r.error}). Delete it or re-take the snap with \`jux snap <url> --as ${ref}\`.\n`,
      );
      return { code: EXIT.failure };
    }
  }
  return { sides: [(ra as { side: SnapSide }).side, (rb as { side: SnapSide }).side] };
}

async function diffTwo(a: string, b: string, flags: DiffFlags): Promise<number> {
  const dir = snapsDir(flags.project);
  const loaded = await loadSides(dir, a, b);
  if ('code' in loaded) return loaded.code;
  const [sa, sb] = loaded.sides;
  const { verdict } = await compareSnaps(sa, sb, {
    command: `jux diff ${a} ${b} --crops`,
  });
  process.stdout.write(
    flags.json ? JSON.stringify(verdict) + '\n' : formatVerdict(verdict),
  );
  return verdict.classification === 'identical' ? EXIT.clean : EXIT.review;
}
