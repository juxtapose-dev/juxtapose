// Promoting a run's capture to a baseline, with its structure sidecar.
//
// One helper because there are three approval paths — `jux approve`,
// `jux init` and the review server behind the Storybook panel — and they
// disagreed: only `jux approve` kept the sidecar, so every baseline `init`
// bootstrapped, and every panel approval, silently dropped its structure.

import { readFile } from 'node:fs/promises';
import { errorMessage } from '../browser/guards.js';
import { decodeStructure } from '../capture/structure.js';
import type { ApprovalMeta, BaselineStore } from '../types.js';

export interface RunStructure {
  gz: Buffer;
  structureHash: string;
}

/**
 * The structure sidecar written beside a run capture (`<x>.webp` →
 * `<x>.structure.json.gz`), or null when there is none.
 *
 * Structure explains a diff, it never gates one: a corrupt sidecar is
 * treated as absent so the image still gets approved.
 */
export async function readRunStructure(imagePath: string): Promise<RunStructure | null> {
  const gz = await readFile(imagePath.replace(/\.webp$/, '.structure.json.gz')).catch(
    () => null,
  );
  if (!gz) return null;
  try {
    const { structureHash } = decodeStructure(gz);
    return typeof structureHash === 'string' ? { gz, structureHash } : null;
  } catch {
    return null;
  }
}

/**
 * Write `image` as the baseline for `storyId`, and the run's structure sidecar
 * beside it when the store can hold one.
 *
 * Throws only if `store.put` does. A sidecar that fails to write is returned
 * as `structureError`, never thrown: the image is already approved by then,
 * and structure must never fail a story.
 */
export async function approveCapture(
  store: BaselineStore,
  storyId: string,
  image: Buffer,
  meta: ApprovalMeta,
  imagePath: string,
): Promise<{ structureError?: string }> {
  // A hash in the manifest with nowhere to keep its sidecar would claim a
  // structure no one can read, so a store without putStructure gets neither.
  const structure = store.putStructure ? await readRunStructure(imagePath) : null;
  await store.put(storyId, image, {
    ...meta,
    ...(structure ? { structureHash: structure.structureHash } : {}),
  });
  if (!structure) return {};
  try {
    await store.putStructure!(storyId, structure.gz);
    return {};
  } catch (err) {
    return { structureError: errorMessage(err) };
  }
}
