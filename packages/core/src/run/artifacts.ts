// Reading a stored run capture back. `jux run` writes each story's image and
// structure sidecar into the run directory as it captures; the flake analysis
// reads the first capture of an unstable story from there instead of keeping
// every first capture in memory until its recheck.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeStructure } from '../capture/structure.js';
import { encodeStoryId } from '../baseline/git-store.js';
import type { StructureSnapshot } from '../types.js';

export async function readRunCapture(
  runDir: string,
  storyId: string,
): Promise<{ image: Buffer; structure?: StructureSnapshot } | undefined> {
  const base = path.join(runDir, 'images', `${encodeStoryId(storyId)}-current`);
  const image = await readFile(`${base}.webp`).catch(() => undefined);
  if (!image) return undefined;
  // A missing or corrupt sidecar only costs the explanation some detail.
  const structure = await readFile(`${base}.structure.json.gz`)
    .then(decodeStructure)
    .catch(() => undefined);
  return { image, ...(structure ? { structure } : {}) };
}
