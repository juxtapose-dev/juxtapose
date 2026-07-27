// Pass/fail authority.
//
// A story passes if its captured bytes hash to the same value the manifest
// recorded at approval time. Byte-exact — there is no threshold to hide behind,
// which is why capture determinism gets the attention it does elsewhere in this
// package.
//
// This module MUST NOT write to disk. It is called once per story per run and
// is the hot path on a green run.

import { createHash } from 'node:crypto';
import type { BaselineManifest, DiffStatus } from '../types.js';

export type BaselineStatus = 'pass' | 'new' | 'changed' | 'stale';

/** Hash the stored representation, not an intermediate.
 *
 *  Always the WebP bytes — never the PNG. The WebP is what gets persisted, so
 *  hashing it means the hash is reproducible from stored artifacts alone. */
export function hashImage(webp: Buffer): string {
  return createHash('sha256').update(webp).digest('hex');
}

export interface AncestryCheck {
  /** True if `commit` is an ancestor of HEAD. */
  isAncestor(commit: string): boolean;
}

/**
 * Resolve one story's status against the manifest.
 *
 * `stale` is the subtle one: a baseline approved on a branch that never merged
 * is not a valid baseline for HEAD, even though the bytes match. Without this
 * check, an abandoned branch's approvals silently become the truth.
 */
export function resolveStatus(
  storyId: string,
  webp: Buffer,
  manifest: BaselineManifest,
  ancestry?: AncestryCheck,
): BaselineStatus {
  const entry = manifest.baselines[storyId];
  if (!entry) return 'new';
  if (entry.hash !== hashImage(webp)) return 'changed';
  if (ancestry && !ancestry.isAncestor(entry.commit)) return 'stale';
  return 'pass';
}

/** Map baseline status onto the reported diff status. Single definition —
 *  the original had this mapping written out in three places. */
export function toDiffStatus(status: BaselineStatus): DiffStatus {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'changed':
      return 'fail';
    case 'stale':
      return 'stale';
    case 'new':
      return 'new';
  }
}
