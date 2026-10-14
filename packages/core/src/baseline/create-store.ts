// One place that maps the `storage` config onto a store, so the CLI and the
// Storybook addon cannot disagree about where baselines are.

import type { StorageConfig } from '../config/schema.js';
import type { BaselineStore } from '../types.js';
import {
  CacheBaselineStore,
  DEFAULT_CACHE_DIR,
  LEGACY_IMAGE_DIR,
  STRUCTURE_DIR,
} from './cache-store.js';
import { GitBaselineStore } from './git-store.js';
import { MANIFEST_NAME } from './manifest-file.js';

export function createBaselineStore(
  projectRoot: string,
  storage: StorageConfig | undefined,
): BaselineStore {
  // No `storage` key is the cache store, not the repo-backed one: projects
  // commit hashes and metadata, never images. The cache store still reads an
  // old committed image layout, so upgrading does not blank existing diffs.
  const chosen: StorageConfig = storage ?? { kind: 'cache' };
  switch (chosen.kind) {
    case 'cache':
      return new CacheBaselineStore({ projectRoot, dir: chosen.dir });
    case 'git':
    case 'fs':
      return new GitBaselineStore({ projectRoot, dir: chosen.dir });
    case 's3':
      throw new Error('the s3 baseline store is not implemented yet');
  }
}

/**
 * What to commit after an approval, as paths relative to the project root.
 * One list so approve, init, doctor and the docs cannot drift apart.
 */
export function committedPaths(storage: StorageConfig | undefined): string[] {
  const chosen: StorageConfig = storage ?? { kind: 'cache' };
  return chosen.kind === 'git' || chosen.kind === 'fs'
    ? [MANIFEST_NAME, chosen.dir ?? LEGACY_IMAGE_DIR]
    : [MANIFEST_NAME, STRUCTURE_DIR];
}

/**
 * Paths that stay out of version control, relative to the project root, in
 * `.gitignore` form (directories end in `/`). Run directories hold per-run
 * captures and reports; the cache holds baseline images, which a project that
 * uses jux never commits.
 */
export function ignoredPaths(storage: StorageConfig | undefined): string[] {
  const chosen: StorageConfig = storage ?? { kind: 'cache' };
  const runs = '.juxtapose/runs/';
  if (chosen.kind !== 'cache') return [runs];
  const dir = (chosen.dir ?? DEFAULT_CACHE_DIR).replace(/\/+$/, '');
  // The default sits under .juxtapose/cache/ so a future cache kind shares one entry.
  return dir === DEFAULT_CACHE_DIR ? ['.juxtapose/cache/', runs] : [`${dir}/`, runs];
}
