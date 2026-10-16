// One place that maps the `storage` config onto a store, so the CLI and the
// Storybook addon cannot disagree about where baselines are.

import {
  REPO_STORE_DIR_PATTERN,
  STORAGE_DIR_PATTERN,
  type StorageConfig,
} from '../config/schema.js';
import type { BaselineStore } from '../types.js';
import {
  CacheBaselineStore,
  DEFAULT_CACHE_DIR,
  LEGACY_IMAGE_DIR,
  tmpDirFor,
} from './cache-store.js';
import { GitBaselineStore } from './git-store.js';
import { STRUCTURE_DIR } from './structure-file.js';
import { MANIFEST_NAME } from './manifest-file.js';

/** A `storage` setting jux refuses; the CLI reports it as a usage error. */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

/**
 * A storage dir comes from the repo's own config, and tools print it inside
 * commands an agent is told to run. The cache dir is held to the strict rule
 * (it lands in `.gitignore`); `git`/`fs` keep accepting any path they always
 * did, minus what could corrupt a printed command.
 */
export function safeStorageDir(
  dir: string | undefined,
  kind: 'cache' | 'git' | 'fs',
): string | undefined {
  // The schema's own pattern, so the runtime backstop cannot drift from it:
  // config is cast, not validated, when it is loaded.
  const pattern = kind === 'cache' ? STORAGE_DIR_PATTERN : REPO_STORE_DIR_PATTERN;
  if (dir !== undefined && !new RegExp(pattern).test(dir))
    throw new StorageConfigError(
      kind === 'cache'
        ? `storage.dir ${JSON.stringify(dir)} is not allowed for the cache: use a relative path inside the project, without \`..\`, glob characters, control characters or a leading '-', and not the manifest`
        : `storage.dir ${JSON.stringify(dir)} is not allowed: it must not start with '-' or contain control, line-separator or bidi characters`,
    );
  return dir;
}

/** Throws StorageConfigError for a setting jux would refuse; no store is made. */
export function checkStorageConfig(storage: StorageConfig | undefined): void {
  if (storage && storage.kind !== 's3') safeStorageDir(storage.dir, storage.kind);
}

export function createBaselineStore(
  projectRoot: string,
  storage: StorageConfig | undefined,
  opts: { onWarning?: (message: string) => void } = {},
): BaselineStore {
  // No `storage` key is the cache store, not the repo-backed one: projects
  // commit hashes and metadata, never images. The cache store still reads an
  // old committed image layout, so upgrading does not blank existing diffs.
  const chosen: StorageConfig = storage ?? { kind: 'cache' };
  switch (chosen.kind) {
    case 'cache':
      return new CacheBaselineStore({
        projectRoot,
        dir: safeStorageDir(chosen.dir, 'cache'),
        ...(opts.onWarning ? { onWarning: opts.onWarning } : {}),
      });
    case 'git':
    case 'fs':
      return new GitBaselineStore({
        projectRoot,
        dir: safeStorageDir(chosen.dir, chosen.kind),
      });
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
    ? [
        MANIFEST_NAME,
        STRUCTURE_DIR,
        safeStorageDir(chosen.dir, chosen.kind) ?? LEGACY_IMAGE_DIR,
      ]
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
  const checked =
    chosen.kind === 's3' ? undefined : safeStorageDir(chosen.dir, chosen.kind);
  // Repo-backed stores commit `.juxtapose/baselines`, so they ignore only the
  // run output.
  if (chosen.kind !== 'cache') return ['.juxtapose/runs/'];
  const dir = (checked ?? DEFAULT_CACHE_DIR).replace(/\/+$/, '');
  // `.juxtapose/` holds only machine-local data (cache, runs, tmp, the old
  // image layout), so one line covers it. A cache dir elsewhere, and the temp
  // dir beside it, need their own.
  return dir.startsWith('.juxtapose/')
    ? [
        '.juxtapose/',
        ...(tmpDirFor(dir).startsWith('.juxtapose/') ? [] : [`${tmpDirFor(dir)}/`]),
      ]
    : ['.juxtapose/', `${dir}/`, `${tmpDirFor(dir)}/`];
}
