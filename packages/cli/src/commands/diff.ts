// `jux diff <a> <b>` — the second half of the agent loop. Two snaps in, one
// tier-0 verdict out, no browser. Exit 0 identical, 1 different, 2 usage,
// 3 when an input exists but cannot be read.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  compareCodeUnits,
  compareSnaps,
  decodeStructure,
  describeDeltas,
  type SnapSide,
  type StructuralVerdict,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
import { shellQuote } from '../shell-quote.js';
import { snapName } from '../snap-name.js';
import { snapsDir } from '../snaps-dir.js';

export interface DiffFlags {
  json?: boolean;
  project?: string;
  crops?: boolean;
  prefix?: boolean;
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
  const image = imagePath(dir, ref);
  const bytes = await readFile(image).catch(() => null);
  if (!bytes) return { kind: 'missing', image };
  // Cheap magic-number check so a truncated or foreign file is attributed to
  // the side it came from; the decoder's own error cannot say which side.
  if (
    bytes.length < 12 ||
    bytes.toString('latin1', 0, 4) !== 'RIFF' ||
    bytes.toString('latin1', 8, 12) !== 'WEBP'
  )
    return { kind: 'corrupt', file: image, error: 'not a WebP image' };
  const sidecar = image.replace(/\.webp$/, '.structure.json.gz');
  const gz = await readFile(sidecar).catch(() => null);
  if (!gz) return { kind: 'ok', side: { image: bytes } };
  try {
    return { kind: 'ok', side: { image: bytes, structure: decodeStructure(gz) } };
  } catch (err) {
    return { kind: 'corrupt', file: sidecar, error: (err as Error).message };
  }
}

/** A snap name's image in the snaps dir, or an explicit `.webp` path. The
 *  path is deliberately unconfined: it is the user's own argument on their
 *  own machine, not a name derived into a snaps/ path. */
function imagePath(dir: string, ref: string): string {
  return ref.endsWith('.webp')
    ? path.resolve(ref)
    : path.join(dir, `${snapName(ref, ref)}.webp`);
}

export function formatVerdict(v: StructuralVerdict): string {
  const lines = [v.summary];
  if (v.deltas.length > 0) {
    lines.push('', ...describeDeltas(v.deltas, v.deltaCount));
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
    // Tier-3 crops land in a later release. Until then the verdict's own
    // `next:` command still has to work, so it names the pixels to open and
    // succeeds: it did what this version can. Exit 2 here sent an agent that
    // followed `next:` into a usage error.
    const dir = snapsDir(flags.project);
    process.stdout.write(
      `open these to compare; crops arrive in a later release\n  ${imagePath(dir, a)}\n  ${imagePath(dir, b)}\n`,
    );
    return EXIT.clean;
  }
  try {
    return await (flags.prefix ? diffPrefix(a, b, flags) : diffTwo(a, b, flags));
  } catch (err) {
    // sharp failing to decode a .webp, or anything else unforeseen: a tool
    // failure, distinct from "different" so a script never approves on it.
    process.stderr.write(
      `jux diff: failed: ${(err as Error).message}. Re-take both snaps with \`jux snap <url> --as ${shellQuote(a)}\` / \`--as ${shellQuote(b)}\` and retry.\n`,
    );
    return EXIT.failure;
  }
}

/** Resolve both sides or explain which one is unusable and how to fix it. */
async function loadSides(
  dir: string,
  a: string,
  b: string,
): Promise<
  { sides: [SnapSide, SnapSide] } | { code: number; message: string; failure: SetFailure }
> {
  const [ra, rb] = await Promise.all([readSnap(dir, a), readSnap(dir, b)]);
  for (const [ref, r] of [
    [a, ra],
    [b, rb],
  ] as const) {
    if (r.kind === 'missing') {
      return {
        code: EXIT.usage,
        failure: { code: 'snap-missing', file: path.basename(r.image) },
        message: ref.endsWith('.webp')
          ? `jux diff: no file at ${r.image}. Check the path, or take it with \`jux snap <url> --as <name>\`.\n`
          : `jux diff: no snap named '${ref}' in ${dir}. Run \`jux snap <url> --as ${shellQuote(ref)}\` first.\n`,
      };
    }
    if (r.kind === 'corrupt') {
      return {
        code: EXIT.failure,
        failure: {
          code: r.file.endsWith('.webp') ? 'image-undecodable' : 'sidecar-undecodable',
          file: path.basename(r.file),
        },
        message: `jux diff: cannot read ${r.file} (${r.error}). Delete it or re-take the snap with \`jux snap <url> --as ${shellQuote(ref)}\`.\n`,
      };
    }
  }
  return { sides: [(ra as { side: SnapSide }).side, (rb as { side: SnapSide }).side] };
}

async function diffTwo(a: string, b: string, flags: DiffFlags): Promise<number> {
  const dir = snapsDir(flags.project);
  const loaded = await loadSides(dir, a, b);
  if ('code' in loaded) {
    process.stderr.write(loaded.message);
    return loaded.code;
  }
  const [sa, sb] = loaded.sides;
  const { verdict } = await compareSnaps(sa, sb, {
    command: `jux diff ${shellQuote(a)} ${shellQuote(b)} --crops`,
  });
  process.stdout.write(
    flags.json ? JSON.stringify(verdict) + '\n' : formatVerdict(verdict),
  );
  return verdict.classification === 'identical' ? EXIT.clean : EXIT.review;
}

export interface PrefixPairing {
  pairs: Array<{ slug: string; a: string; b: string }>;
  missing: Array<{ slug: string; have: string; want: string }>;
}

/** Pair `<a>-<slug>.webp` with `<b>-<slug>.webp`, sorted by slug. */
export function pairByPrefix(files: string[], a: string, b: string): PrefixPairing {
  const slugs = (p: string) =>
    new Set(
      files
        .filter((f) => f.startsWith(`${p}-`) && f.endsWith('.webp'))
        .map((f) => f.slice(p.length + 1, -'.webp'.length)),
    );
  const sa = slugs(a);
  const sb = slugs(b);
  // Code-unit order, so the output is the same on every machine.
  const all = [...new Set([...sa, ...sb])].sort(compareCodeUnits);
  const pairs: PrefixPairing['pairs'] = [];
  const missing: PrefixPairing['missing'] = [];
  for (const slug of all) {
    if (sa.has(slug) && sb.has(slug))
      pairs.push({ slug, a: `${a}-${slug}`, b: `${b}-${slug}` });
    else if (sa.has(slug))
      missing.push({ slug, have: `${a}-${slug}`, want: `${b}-${slug}` });
    else missing.push({ slug, have: `${b}-${slug}`, want: `${a}-${slug}` });
  }
  return { pairs, missing };
}

interface PageVerdict {
  slug: string;
  a: string;
  b: string;
  verdict: StructuralVerdict;
}

/** Stable, machine-readable reasons a pair could not be compared. No OS error
 *  text ever reaches the JSON: it varies by platform and leaks paths. */
type SetFailureCode =
  | 'snap-missing'
  | 'sidecar-undecodable'
  | 'image-undecodable'
  /** Both images passed the magic-number check and the decoder still threw:
   *  its error cannot say which side, so `file` is null. */
  | 'pair-undecodable';

interface SetFailure {
  code: SetFailureCode;
  /** The snap file's basename (always directly in the snaps dir), never a
   *  relative path: `path.relative` prints backslashes on Windows, and this
   *  field is documented as machine-stable. Null when no one file is at
   *  fault. */
  file: string | null;
}

/** `errors[]` entry in `juxtapose.verdict-set/v1`. */
interface PageError extends SetFailure {
  slug: string;
}

/** What the human output adds: the full message, never serialized. */
interface PageFailure extends PageError {
  message: string;
}

async function diffPrefix(a: string, b: string, flags: DiffFlags): Promise<number> {
  const dir = snapsDir(flags.project);
  const pa = snapName(a, a);
  const pb = snapName(b, b);
  // `a` matches every `a-<slug>`, so a prefix nested in the other would pair
  // one side's snaps with themselves or swallow the other's.
  if (pa === pb || pa.startsWith(`${pb}-`) || pb.startsWith(`${pa}-`)) {
    process.stderr.write(
      `jux diff: prefixes '${pa}' and '${pb}' overlap (one is the other plus '-…'), so their snaps cannot be told apart. Re-take the snaps under unrelated prefixes, e.g. \`jux snap <url>… --as-prefix before\` and \`--as-prefix after\`.\n`,
    );
    return EXIT.usage;
  }
  const files = await readdir(dir).catch(() => [] as string[]);
  const { pairs, missing } = pairByPrefix(files, pa, pb);
  if (pairs.length === 0 && missing.length === 0) {
    process.stderr.write(
      `jux diff: no snaps named '${pa}-*' or '${pb}-*' in ${dir}. Run \`jux snap <url>… --as-prefix ${shellQuote(pa)}\` first.\n`,
    );
    return EXIT.usage;
  }
  const pages: PageVerdict[] = [];
  const failures: PageFailure[] = [];
  for (const p of pairs) {
    // One unreadable pair must not hide the verdicts of the others.
    try {
      const loaded = await loadSides(dir, p.a, p.b);
      if ('code' in loaded) {
        failures.push({
          slug: p.slug,
          ...loaded.failure,
          message: loaded.message.trim(),
        });
        continue;
      }
      const [sa, sb] = loaded.sides;
      const { verdict } = await compareSnaps(sa, sb, {
        command: `jux diff ${shellQuote(p.a)} ${shellQuote(p.b)} --crops`,
      });
      pages.push({ ...p, verdict });
    } catch (err) {
      // The magic-number check already caught foreign files, so this is a
      // decoder failure the error cannot pin to a side.
      failures.push({
        slug: p.slug,
        code: 'pair-undecodable',
        file: null,
        message: `jux diff: failed: ${err instanceof Error ? err.message : String(err)}. Re-take both with \`jux snap <url> --as ${shellQuote(p.a)}\` / \`--as ${shellQuote(p.b)}\`.`,
      });
    }
  }
  const summary = {
    identical: pages.filter((p) => p.verdict.classification === 'identical').length,
    different: pages.filter((p) => p.verdict.classification !== 'identical').length,
    missing: missing.length,
    errored: failures.length,
  };
  process.stdout.write(
    flags.json
      ? JSON.stringify({
          schema: 'juxtapose.verdict-set/v1',
          pages,
          missing,
          errors: failures.map(({ slug, code, file }) => ({ slug, code, file })),
          summary,
        }) + '\n'
      : formatPrefixSet(pages, missing, failures, summary, pa, pb),
  );
  if (summary.errored > 0) return EXIT.failure;
  return summary.different === 0 && summary.missing === 0 ? EXIT.clean : EXIT.review;
}

/** Page-level summary first, then what changed, then the quiet pages. */
function formatPrefixSet(
  pages: PageVerdict[],
  missing: PrefixPairing['missing'],
  errors: PageFailure[],
  summary: { identical: number; different: number; missing: number; errored: number },
  pa: string,
  pb: string,
): string {
  const total = pages.length + missing.length + errors.length;
  const parts: string[] = [];
  if (summary.different) parts.push(`${summary.different} changed`);
  if (summary.identical) parts.push(`${summary.identical} identical`);
  if (summary.errored) parts.push(`${summary.errored} unreadable`);
  let head = `${total} page${total === 1 ? '' : 's'}: ${parts.join(', ') || 'none paired'}`;
  for (const prefix of [pb, pa]) {
    const slugs = missing
      .filter((m) => m.want === `${prefix}-${m.slug}`)
      .map((m) => m.slug);
    if (slugs.length) head += `; missing ${prefix}: ${slugs.join(', ')}`;
  }
  const out = [head, ''];
  for (const p of pages.filter((x) => x.verdict.classification !== 'identical')) {
    out.push(`${p.slug}: ${formatVerdict(p.verdict).trimEnd()}`, '');
  }
  for (const p of pages.filter((x) => x.verdict.classification === 'identical'))
    out.push(`${p.slug}: ${p.verdict.summary}`);
  for (const e of errors) out.push(`${e.slug}: ${e.message}`);
  // A slug that is path-based changes when the page's host or path does, so
  // that is the usual reason one side has no snap for it.
  for (const m of missing)
    out.push(
      `${m.slug}: no ${m.want}. A changed host or path is the usual cause; re-run \`jux snap <url>… --as-prefix ${shellQuote(m.want === `${pb}-${m.slug}` ? pb : pa)}\` with the same paths, or take just this one with \`jux snap <url> --as ${shellQuote(m.want)}\`.`,
    );
  return out.join('\n').trimEnd() + '\n';
}
