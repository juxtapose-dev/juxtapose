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

type ViteManifest = Record<string, ViteManifestEntry>;

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

export async function resolveAffected(
  stories: StoryManifest[],
  sinceCommit: string | null,
  opts: AffectedOptions,
): Promise<AffectedResult> {
  // No point of comparison — everything is affected.
  if (sinceCommit === null && !opts.changedFiles) {
    return { stories, reason: 'no-baseline' };
  }

  const changed =
    opts.changedFiles ?? gitChangedFiles(sinceCommit!, opts.projectRoot);

  if (changed === null) return { stories, reason: 'git-unavailable' };
  if (changed.length === 0) return { stories: [], reason: 'no-changes' };

  for (const file of changed) {
    const base = file.split('/').pop() ?? file;
    if (LOCKFILES.has(base) && !file.includes('/')) {
      return { stories, reason: 'dependency-changed' };
    }
    if (opts.configDirs.some((dir) => file === dir || file.startsWith(dir + '/'))) {
      return { stories, reason: 'config-changed' };
    }
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
 * Build `imported → importers` from Vite's manifest.
 *
 * Vite's `imports[]` holds chunk keys, not source paths, so resolving an edge
 * means mapping key → src first.
 */
function buildReverseGraph(manifest: ViteManifest): Map<string, Set<string>> {
  const keyToSrc = new Map<string, string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.src) keyToSrc.set(key, entry.src);
  }

  const reverse = new Map<string, Set<string>>();
  for (const entry of Object.values(manifest)) {
    const importer = entry.src;
    if (!importer) continue;
    for (const key of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
      const imported = keyToSrc.get(key) ?? key;
      let set = reverse.get(imported);
      if (!set) reverse.set(imported, (set = new Set()));
      set.add(importer);
    }
  }
  return reverse;
}

/** Transitive dependents, including the seeds themselves — a changed story
 *  file is its own story's entry point. */
function walkDependents(
  reverse: Map<string, Set<string>>,
  seeds: string[],
): Set<string> {
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

async function loadViteManifest(buildDir: string): Promise<ViteManifest | null> {
  for (const rel of ['.vite/manifest.json', 'manifest.json']) {
    try {
      return JSON.parse(await readFile(path.join(buildDir, rel), 'utf8')) as ViteManifest;
    } catch {
      // try next
    }
  }
  return null;
}

function gitChangedFiles(sinceCommit: string, cwd: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', `${sinceCommit}..HEAD`],
      { cwd, encoding: 'utf8' },
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
