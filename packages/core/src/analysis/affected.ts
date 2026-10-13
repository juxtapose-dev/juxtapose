// Which stories does a change actually affect?
//
// Capturing 700 stories when 3 changed is the difference between a check
// developers wait for and one they route around. But the failure modes are
// asymmetric and that shapes every decision here:
//
//   false positive → a few seconds of wasted capture
//   false negative → a visual regression ships
//
// So every uncertain path escalates to a full run. This module is deliberately
// eager to give up.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoryManifest } from '../types.js';

interface ViteManifestEntry {
  file: string;
  src?: string;
  imports?: string[];
  dynamicImports?: string[];
}

export type ViteManifest = Record<string, ViteManifestEntry>;

export interface AffectedOptions {
  projectRoot: string;
  /** Directories whose contents invalidate everything, from the platform
   *  adapter (`.storybook`, `.ladle`, …). */
  configDirs: string[];
  /** Built workbench dir, for locating the Vite manifest. Omit for dev-server
   *  mode, where no manifest exists on disk. */
  buildDir?: string;
  /** Explicit file list, bypassing git. Used by the HMR path and by tests. */
  changedFiles?: string[];
}

export interface AffectedResult {
  stories: StoryManifest[];
  /** Why this set was chosen — surfaced in the report so a full run is never
   *  mysterious. */
  reason:
    | 'no-baseline'
    | 'config-changed'
    | 'dependency-changed'
    | 'graph-walk'
    | 'no-match-fallback'
    | 'git-unavailable'
    | 'no-changes';
}

const LOCKFILES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

/** A root lockfile: dependencies changed, so every story may render
 *  differently. A nested package.json (a fixture) is not one. */
export function isLockfileChange(file: string): boolean {
  const base = file.split('/').pop() ?? file;
  return LOCKFILES.has(base) && !file.includes('/');
}

/** A root `tsconfig*.json`: compiler options reach every module, and the
 *  manifest never names it, so without this a tsconfig edit beside a
 *  component edit narrowed the run to that component's stories. */
export function isTsconfigChange(file: string): boolean {
  return !file.includes('/') && /^tsconfig(\..+)?\.json$/.test(file);
}

/** Anything under a platform config dir (`.storybook`, `.ladle`) reaches
 *  every story. */
export function isConfigChange(file: string, configDirs: string[]): boolean {
  return configDirs.some((dir) => file === dir || file.startsWith(dir + '/'));
}

export async function resolveAffected(
  stories: StoryManifest[],
  sinceCommit: string | null,
  opts: AffectedOptions,
): Promise<AffectedResult> {
  // No point of comparison — everything is affected.
  if (sinceCommit === null && !opts.changedFiles) {
    return { stories, reason: 'no-baseline' };
  }

  const changed = opts.changedFiles ?? gitChangedFiles(sinceCommit!, opts.projectRoot);

  if (changed === null) return { stories, reason: 'git-unavailable' };
  if (changed.length === 0) return { stories: [], reason: 'no-changes' };

  for (const file of changed) {
    if (isLockfileChange(file)) return { stories, reason: 'dependency-changed' };
    if (isTsconfigChange(file)) return { stories, reason: 'config-changed' };
    if (isConfigChange(file, opts.configDirs))
      return { stories, reason: 'config-changed' };
  }

  const manifest = opts.buildDir ? await loadViteManifest(opts.buildDir) : null;
  if (!manifest) {
    // Without a bundler graph we can't prove what's unaffected. Say so rather
    // than guessing with filename heuristics.
    return { stories, reason: 'no-match-fallback' };
  }

  const affected = walkDependents(buildReverseGraph(manifest), changed);

  const matched = stories.filter((s) => {
    const rel = toPosixRelative(opts.projectRoot, s.componentPath);
    return affected.has(rel);
  });

  // Files changed but nothing matched — the change is outside the graph we
  // know about. Could be a public asset, a global stylesheet, a util the
  // manifest didn't record. Capture everything.
  if (matched.length === 0) return { stories, reason: 'no-match-fallback' };

  return { stories: matched, reason: 'graph-walk' };
}

/**
 * Which stories a set of source files could affect, without consulting git.
 *
 * This is the watch-mode entry point, and it inverts the fail-safe that
 * `resolveAffected` uses. There, an uncertain answer escalates to capturing
 * everything, because a missed story ships a regression. Here the trigger is a
 * developer typing: escalating would recapture the whole suite on every
 * keystroke-pause, which is not a safety net, it is a hang. An uncertain answer
 * narrows to the files we know changed, and the CI run remains the backstop
 * that cannot be fooled.
 *
 * The bundler graph is best-effort. Storybook's dev server has no build
 * manifest, so when `buildDir` is absent or unbuilt we fall back to matching
 * stories by their own component path — edit `Button.tsx` and every Button
 * story recaptures. That misses a `Card` that imports `Button`; a build lying
 * around upgrades the answer for free.
 */
export async function resolveAffectedFromPaths(
  stories: StoryManifest[],
  changedFiles: string[],
  opts: { projectRoot: string; buildDir?: string },
): Promise<StoryManifest[]> {
  if (changedFiles.length === 0) return [];

  const changed = changedFiles.map((f) =>
    toPosixRelative(opts.projectRoot, path.resolve(opts.projectRoot, f)),
  );

  if (opts.buildDir) {
    const manifest = await loadViteManifest(opts.buildDir);
    if (manifest) {
      const affected = walkDependents(buildReverseGraph(manifest), changed);
      const matched = stories.filter((s) =>
        affected.has(toPosixRelative(opts.projectRoot, s.componentPath)),
      );
      // An empty result means the graph does not know these files, not that
      // nothing depends on them — fall through rather than reporting none.
      if (matched.length > 0) return matched;
    }
  }

  return stories.filter((s) => {
    const rel = toPosixRelative(opts.projectRoot, s.componentPath);
    return changed.some(
      (c) => rel === c || rel.endsWith('/' + c) || c.endsWith('/' + rel),
    );
  });
}

/** Vite's `imports[]` holds chunk keys, not source paths; this is the map
 *  both graph directions resolve an edge through. A chunk with no `src` (a
 *  bundled component chunk in a Storybook build) has no entry. */
export function keyToSrc(manifest: ViteManifest): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.src) map.set(key, entry.src);
  }
  return map;
}

/**
 * Build `imported → importers` from Vite's manifest.
 *
 * Vite's `imports[]` holds chunk keys, not source paths, so resolving an edge
 * means mapping key → src first.
 */
function buildReverseGraph(manifest: ViteManifest): Map<string, Set<string>> {
  const srcOf = keyToSrc(manifest);

  const reverse = new Map<string, Set<string>>();
  for (const entry of Object.values(manifest)) {
    const importer = entry.src;
    if (!importer) continue;
    for (const key of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
      const imported = srcOf.get(key) ?? key;
      let set = reverse.get(imported);
      if (!set) reverse.set(imported, (set = new Set()));
      set.add(importer);
    }
  }
  return reverse;
}

/** Transitive dependents, including the seeds themselves — a changed story
 *  file is its own story's entry point. */
function walkDependents(reverse: Map<string, Set<string>>, seeds: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dependent of reverse.get(file) ?? []) {
      if (!seen.has(dependent)) stack.push(dependent);
    }
  }
  return seen;
}

export async function loadViteManifest(buildDir: string): Promise<ViteManifest | null> {
  for (const rel of ['.vite/manifest.json', 'manifest.json']) {
    try {
      return JSON.parse(await readFile(path.join(buildDir, rel), 'utf8')) as ViteManifest;
    } catch {
      // try next
    }
  }
  return null;
}

/** The files changed since `sinceCommit`, as git prints them: relative to
 *  the repository top level, forward slashes. The working tree counts (an
 *  agent asks before it commits), and so do untracked files that are not
 *  ignored. Null when git cannot say. NUL-separated with no trimming, so a
 *  name with a space, a newline or a non-ASCII character is read exactly;
 *  without `-z` git quotes such names and the quoted form matches nothing. */
export function gitChangedFiles(sinceCommit: string, cwd: string): string[] | null {
  // A leading dash would be read as an option (`--output=<file>` writes one).
  if (sinceCommit.startsWith('-')) return null;
  try {
    const tracked = git(['diff', '--name-only', '-z', sinceCommit, '--'], cwd);
    // `:/` and `--full-name`: the whole repository, top-level-relative, even
    // when cwd is a subdirectory, matching `git diff`'s paths.
    const untracked = git(
      ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', ':/'],
      cwd,
    );
    return [...new Set([...tracked.split('\0'), ...untracked.split('\0')])].filter(
      (f) => f.length > 0,
    );
  } catch {
    return null;
  }
}

/** The repository root, which git's paths are relative to. Null outside a
 *  repository or without git. */
export function gitTopLevel(cwd: string): string | null {
  try {
    // Only the line end: a directory name may itself end in a space.
    return git(['rev-parse', '--show-toplevel'], cwd).replace(/\n$/, '');
  } catch {
    return null;
  }
}

const GIT_TIMEOUT_MS = 10_000;

/** Every git call goes through here. Git's stderr is dropped: outside a
 *  repository it printed "fatal: not a git repository" and `git diff`'s full
 *  usage text to the user's terminal, for a failure the caller already
 *  handles. The timeout bounds a git that hangs (a lock, a network
 *  filesystem); a timeout is a failure like any other. */
function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
  });
}

export function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
