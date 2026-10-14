// The manifest file, shared by every store: it is committed whichever way the
// image bytes are kept, so reading and writing it is not a store concern.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import type { BaselineManifest } from '../types.js';
import { isRecord } from '../browser/guards.js';

export const MANIFEST_NAME = 'juxtapose.manifest.json';

/**
 * The envelope only: version 1 and a `baselines` object. A null or array
 * `baselines` (which `typeof` used to let through, to fail on first use) reads
 * as corrupt, like any other damaged manifest. Entries are not checked one by
 * one.
 */
function isBaselineManifest(v: unknown): v is BaselineManifest {
  return isRecord(v) && v['version'] === 1 && isRecord(v['baselines']);
}

const emptyManifest = (): BaselineManifest => ({ version: 1, baselines: {} });

export async function readManifestFile(file: string): Promise<BaselineManifest> {
  if (!existsSync(file)) return emptyManifest();
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isBaselineManifest(parsed) ? parsed : emptyManifest();
  } catch {
    // A corrupt manifest means every story reads as `new`, which is loud and
    // recoverable. Throwing here would block the run entirely.
    return emptyManifest();
  }
}

/** For the sync `locate`, which a handoff calls while building a prompt. */
export function readManifestFileSync(file: string): BaselineManifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isBaselineManifest(parsed) ? parsed : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

export async function writeManifestFile(
  file: string,
  manifest: BaselineManifest,
): Promise<void> {
  // Sort keys so the committed file produces a minimal, readable diff — the
  // whole point of keeping the hashes in the repo.
  const sorted: BaselineManifest = { version: 1, baselines: {} };
  for (const id of Object.keys(manifest.baselines).sort()) {
    sorted.baselines[id] = manifest.baselines[id]!; // id is one of its own keys
  }
  await writeFile(file, JSON.stringify(sorted, null, 2) + '\n');
}
