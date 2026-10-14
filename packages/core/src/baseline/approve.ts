// Promoting a run's capture to a baseline, with its structure sidecar.
//
// One helper because there are three approval paths — `jux approve`,
// `jux init` and the review server behind the Storybook panel — and they
// disagreed: only `jux approve` kept the sidecar, so every baseline `init`
// bootstrapped, and every panel approval, silently dropped its structure.

import { readFile } from 'node:fs/promises';
import { errorMessage } from '../browser/guards.js';
import { decodeStructure, formatStructure } from '../capture/structure.js';
import type { ApprovalMeta, BaselineStore } from '../types.js';

/**
 * Refusal to approve a capture the run saw come out two different ways.
 * Baselining it would turn a flake into a permanently red story.
 */
export class UnstableCaptureError extends Error {
  constructor(
    readonly storyId: string,
    unstable: { hashes: string[]; unconfirmed?: string },
    opts: { freshRenderer?: boolean } = {},
  ) {
    // Only suggest freshRenderer when it is off (or unknown): it is on by
    // default, so telling someone to set it is usually noise.
    const fixes =
      'mask the changing region, add a `stories` override in config' +
      (opts.freshRenderer === true ? '' : ', or turn `freshRenderer` on');
    const override = 'CLI --allow-unstable, MCP allowUnstable';
    super(
      unstable.unconfirmed !== undefined
        ? `story '${storyId}' could not be confirmed stable: the recheck capture failed ` +
            `(${unstable.unconfirmed}), so approving it would rest on one capture. Re-run it, ` +
            `or approve anyway (${override}).`
        : `story '${storyId}' is unstable: two captures of it differed, so approving it would ` +
            `baseline a flake. Fix the cause (${fixes}), or approve anyway (${override}).`,
    );
    this.name = 'UnstableCaptureError';
  }
}

/** The `unstable.unconfirmed` text of a story the run captured only once. */
export const NOT_RECHECKED = 'not rechecked';

/** One line for any surface that lists a result: why approval is refused. */
export function describeUnstable(u: { hashes: string[]; unconfirmed?: string }): string {
  if (u.unconfirmed?.startsWith(NOT_RECHECKED))
    return `${u.unconfirmed}: captured once; \`jux approve\` captures it again`;
  return u.unconfirmed !== undefined
    ? `unconfirmed: recheck capture failed (${u.unconfirmed})`
    : 'unstable: two captures differed; approve refuses it';
}

export interface RunStructure {
  /** The run's sidecar as written (gzip), for callers that forward it as is. */
  gz: Buffer;
  /** The committed form: readable JSON, one element per line. */
  stored: Buffer;
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
    const snapshot = decodeStructure(gz);
    return typeof snapshot.structureHash === 'string'
      ? { gz, stored: formatStructure(snapshot), structureHash: snapshot.structureHash }
      : null;
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
    await store.putStructure!(storyId, structure.stored);
    return {};
  } catch (err) {
    return { structureError: errorMessage(err) };
  }
}
