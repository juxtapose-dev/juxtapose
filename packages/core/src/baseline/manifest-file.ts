// The manifest file, shared by every store: it is committed whichever way the
// image bytes are kept, so reading and writing it is not a store concern.
//
// It is the project's lockfile. Per story it holds the approved hash (the
// pass/fail authority) and, for the default store, the structure snapshot that
// lets CI say which elements changed without an image. Like a lockfile it is
// regenerated, not hand-merged; see ManifestConflictError.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import type { BaselineEntry, BaselineManifest } from '../types.js';
import { isRecord } from '../browser/guards.js';

export const MANIFEST_NAME = 'juxtapose.manifest.json';

/**
 * The manifest is always written as version 1. The inline `structure` on an
 * entry is additive: a reader from before it existed checks `version === 1`,
 * reads each entry's `hash`, and ignores fields it does not know, so bumping
 * the version would make an older jux read the whole manifest as empty (every
 * story `new`). 2 is still read, for a manifest an unreleased build wrote.
 */
const READABLE_VERSIONS: readonly number[] = [1, 2];

/**
 * The manifest holds merge conflict markers. Thrown rather than treated as
 * corrupt: reading it as empty would report every story `new` and invite an
 * approve-all that bakes in whatever the working tree happened to contain.
 */
export class ManifestConflictError extends Error {
  constructor() {
    super(
      `${MANIFEST_NAME} has merge conflict markers. Don't hand-merge it: it is a ` +
        `lockfile you regenerate. Take either side (git checkout --theirs ${MANIFEST_NAME} ` +
        `or --ours), run \`jux run\`, then \`jux approve --story <id>\` for each story the ` +
        `two branches changed (or \`jux approve --all\` if you reviewed the run).`,
    );
    this.name = 'ManifestConflictError';
  }
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/** True when `text` holds merge conflict markers. */
export const hasConflictMarkers = (text: string): boolean => CONFLICT_MARKER.test(text);

/**
 * The envelope only: a known version and a `baselines` object. A null or array
 * `baselines` (which `typeof` used to let through, to fail on first use) reads
 * as corrupt, like any other damaged manifest. Entries are not checked one by
 * one.
 */
function isBaselineManifest(v: unknown): v is BaselineManifest {
  return (
    isRecord(v) &&
    typeof v['version'] === 'number' &&
    READABLE_VERSIONS.includes(v['version']) &&
    isRecord(v['baselines'])
  );
}

const emptyManifest = (): BaselineManifest => ({ version: 1, baselines: {} });

function parseManifest(text: string): BaselineManifest {
  if (hasConflictMarkers(text)) throw new ManifestConflictError();
  try {
    const parsed: unknown = JSON.parse(text);
    // A corrupt manifest means every story reads as `new`, which is loud and
    // recoverable. Throwing here would block the run entirely.
    return isBaselineManifest(parsed) ? parsed : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

export async function readManifestFile(file: string): Promise<BaselineManifest> {
  if (!existsSync(file)) return emptyManifest();
  return parseManifest(await readFile(file, 'utf8'));
}

/** For the sync `locate`, which a handoff calls while building a prompt. */
export function readManifestFileSync(file: string): BaselineManifest {
  try {
    return parseManifest(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err instanceof ManifestConflictError) throw err;
    return emptyManifest();
  }
}

const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map((l) => by + l)
    .join('\n');

/**
 * One story's entry. Everything but `structure` is ordinary pretty JSON; the
 * structure takes a line per element, so approving one story changes only that
 * story's lines and a changed element shows as one changed line. No key is
 * computed from the machine or the clock, so rewriting an unchanged story
 * reproduces its bytes.
 */
function serializeEntry(entry: BaselineEntry): string {
  const { structure, ...rest } = entry;
  const head = JSON.stringify(rest, null, 2);
  if (!structure) return head;
  const { elements, ...others } = structure;
  const lines = Object.entries(others).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
  );
  const body = elements.length
    ? `\n${elements.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  `
    : '';
  const block = `${lines.join('\n')}\n  "elements": [${body}]`;
  return `${head.slice(0, -2)},\n  "structure": {\n${indent(block, '  ')}\n  }\n}`;
}

export async function writeManifestFile(
  file: string,
  manifest: BaselineManifest,
): Promise<void> {
  // Sorted by id (code unit order, as `sort()` does) so the committed file
  // produces a minimal, readable diff — the whole point of keeping the hashes
  // in the repo.
  const ids = Object.keys(manifest.baselines).sort();
  const entries = ids.map(
    (id) =>
      `${indent(JSON.stringify(id), '    ')}: ${indent(serializeEntry(manifest.baselines[id]!), '    ').trimStart()}`,
  );
  const body = entries.length ? `\n${entries.join(',\n')}\n  ` : '';
  await writeFile(file, `{\n  "version": 1,\n  "baselines": {${body}}\n}\n`);
}
