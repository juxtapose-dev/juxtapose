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
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isRecord, isStringArray } from '../browser/guards.js';
import type { StoryManifest } from '../types.js';
import { loadModuleGraph, type ModuleGraph } from './module-graph.js';

interface ViteManifestEntry {
  /** Always written by Vite; never read here, so not required of the file. */
  file?: string;
  src?: string;
  imports?: string[];
  dynamicImports?: string[];
}

export type ViteManifest = Record<string, ViteManifestEntry>;

const optional = <T>(v: unknown, is: (v: unknown) => v is T) => v === undefined || is(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/** The fields buildReverseGraph reads, with the types it reads them as. */
function isViteManifest(v: unknown): v is ViteManifest {
  return (
    isRecord(v) &&
    Object.values(v).every(
      (e) =>
        isRecord(e) &&
        optional(e['src'], isString) &&
        optional(e['imports'], isStringArray) &&
        optional(e['dynamicImports'], isStringArray),
    )
  );
}

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
  /** A running workbench is being captured (`--origin`), not the build. */
  origin?: string;
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
    | 'unmapped-change'
    | 'shared-entry-changed'
    | 'asset-changed'
    | 'stale-graph'
    | 'graph-root-mismatch'
    | 'origin-run'
    | 'no-match-fallback'
    | 'git-unavailable'
    | 'no-changes';
  /** What to look at when `reason` escalated: the file that could not be
   *  mapped, or how to get a graph. Printed beside the reason. */
  detail?: string;
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

/** A juxtapose config file: it can declare project-wide variants and
 *  per-story `stories` overrides (and viewport, thresholds) that change every story's captures, and no bundler
 *  graph names it. Matched at any depth, unlike a lockfile: changed paths are
 *  repository-relative, and a project in a subdirectory keeps its config
 *  there. A nested match is at worst a full run, which is the safe direction.
 *  The project's own `package.json` (which can carry `juxtapose`) is
 *  `isProjectPackageJson`'s job: only the one at the project root counts. */
export function isJuxtaposeConfigChange(file: string): boolean {
  const base = file.split('/').pop() ?? file;
  return base === 'juxtapose.config.json' || base === '.juxtaposerc.json';
}

/** The jux project's own package.json, whose `juxtapose` key is config
 *  like `juxtapose.config.json`. `projectPrefix` is the project root relative
 *  to the repository (`apps/web/`, or '' at the root), the base changed paths
 *  are reported against. At the root it is also a lockfile-list entry, which
 *  escalates first as `dependency-changed`. */
export function isProjectPackageJson(file: string, projectPrefix: string): boolean {
  return file === `${projectPrefix}package.json`;
}

/** The project root relative to the repository top, with a trailing slash;
 *  '' at the top or outside git. */
export function gitProjectPrefix(projectRoot: string): string {
  try {
    return git(['rev-parse', '--show-prefix'], projectRoot).trim();
  } catch {
    return '';
  }
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

  const prefix = gitProjectPrefix(opts.projectRoot);
  // Git paths are repository-relative; the module graph and the manifest are
  // project-relative (#96). The global-change rules look at both forms: a
  // project below the repository top has its own lockfile, tsconfig and
  // config dir, which only the project-relative form shows.
  const files = changed.map((repoPath) => ({
    repoPath,
    path: repoToProjectPath(repoPath, prefix),
  }));
  for (const { repoPath, path: file } of files) {
    if (isLockfileChange(repoPath)) return { stories, reason: 'dependency-changed' };
    if (isTsconfigChange(repoPath)) return { stories, reason: 'config-changed' };
    if (isJuxtaposeConfigChange(repoPath)) return { stories, reason: 'config-changed' };
    if (isProjectPackageJson(repoPath, prefix))
      return { stories, reason: 'config-changed' };
    if (file !== 'package.json' && isLockfileChange(file))
      return { stories, reason: 'dependency-changed' };
    if (isTsconfigChange(file)) return { stories, reason: 'config-changed' };
    if (
      isConfigChange(repoPath, opts.configDirs) ||
      isConfigChange(file, opts.configDirs)
    )
      return { stories, reason: 'config-changed' };
  }

  // A dev server or deployed workbench is not the build in `buildDir`: its
  // modules can differ from the graph's in ways nothing here can see.
  if (opts.origin) {
    return {
      stories,
      reason: 'origin-run',
      detail:
        '--origin captures a running server, not the build in the build dir, so that build’s import graph does not describe it',
    };
  }

  const hint = opts.buildDir ? await noGraphHint(opts.buildDir) : NO_GRAPH_HINT;
  const graph = opts.buildDir ? await loadModuleGraph(opts.buildDir) : null;
  if (graph) {
    const problem = await graphProblem(graph, opts.projectRoot, files);
    if (problem) return { stories, ...problem };
    return walkModuleGraph(stories, files, graph, opts.projectRoot, opts.configDirs);
  }

  const manifest = opts.buildDir ? await loadViteManifest(opts.buildDir) : null;
  if (!manifest) {
    // Without a bundler graph we can't prove what's unaffected. Say so rather
    // than guessing with filename heuristics.
    return { stories, reason: 'no-match-fallback', detail: hint };
  }

  // The manifest names story files and the odd entry, but not the modules
  // Rollup bundled into chunks. A changed file it does not name could be
  // inside any of them, so one unnamed file (beside a story edit, say) must
  // not let the named ones narrow the run.
  const named = new Set(Object.values(manifest).flatMap((e) => (e.src ? [e.src] : [])));
  if (files.some((f) => !named.has(f.path) && !isNeverBundled(f))) {
    return { stories, reason: 'no-match-fallback', detail: hint };
  }

  const affected = walkDependents(
    buildReverseGraph(manifest),
    files.map((f) => f.path),
  );

  const matched = stories.filter((s) => {
    const rel = toPosixRelative(opts.projectRoot, s.componentPath);
    return affected.has(rel);
  });

  // Files changed but nothing matched — the change is outside the graph we
  // know about. Could be a public asset, a global stylesheet, a util the
  // manifest didn't record. Capture everything.
  if (matched.length === 0) {
    return { stories, reason: 'no-match-fallback', detail: hint };
  }

  return { stories: matched, reason: 'graph-walk' };
}

const NO_GRAPH_HINT =
  'the build has no module graph; add the juxtapose Vite plugin (the Storybook addon does) and rebuild';

/** Storybook's `project.json` names its builder. A webpack build cannot carry
 *  the Vite plugin, so telling its owner to add one would be wrong. */
async function noGraphHint(buildDir: string): Promise<string> {
  try {
    const project: unknown = JSON.parse(
      await readFile(path.join(buildDir, 'project.json'), 'utf8'),
    );
    const builder = isRecord(project) ? project['builder'] : undefined;
    if (typeof builder === 'string' && !/vite/i.test(builder)) {
      return `narrowing is not available for ${builder} builds (the module graph comes from a Vite plugin)`;
    }
  } catch {
    // no project.json: not a Storybook build, or an old one
  }
  return NO_GRAPH_HINT;
}

/** Reasons the graph cannot be trusted for this run, checked before any edge
 *  is read. Null when it can. */
async function graphProblem(
  graph: ModuleGraph,
  projectRoot: string,
  files: ChangedPath[],
): Promise<Pick<AffectedResult, 'reason' | 'detail'> | null> {
  if (!sameDir(graph.root, projectRoot)) {
    return {
      reason: 'graph-root-mismatch',
      detail: `the build's module graph is relative to ${graph.root}, but the jux project root is ${projectRoot}; build from the project root, or set JUXTAPOSE_ROOT for the build`,
    };
  }
  // The graph describes the sources as the build read them. A file modified
  // since is not what it describes (a forgotten rebuild, a branch switch).
  const stale = await newerThan(
    graph.builtAt,
    [...graph.modules.keys(), ...files.map((f) => f.path)].map((rel) =>
      path.resolve(graph.root, rel),
    ),
  );
  if (stale) {
    return {
      reason: 'stale-graph',
      detail: `${toPosixRelative(graph.root, stale)} was modified after the workbench was built: rebuild the workbench`,
    };
  }
  return null;
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return norm(a) === norm(b);
}

/** The first of `files` modified after `time`, or null. Missing files (a
 *  deleted module) are not newer. */
async function newerThan(time: number, files: string[]): Promise<string | null> {
  const BATCH = 256;
  for (let i = 0; i < files.length; i += BATCH) {
    const hits = await Promise.all(
      files.slice(i, i + BATCH).map(async (f) => {
        try {
          return (await stat(f)).mtimeMs > time ? f : null;
        } catch {
          return null;
        }
      }),
    );
    const hit = hits.find((h) => h !== null);
    if (hit) return hit;
  }
  return null;
}

/** Source the bundler runs as code; everything else is a stylesheet or an
 *  asset, whose importers are found by parsing rather than by the bundler. */
const CODE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|mdx)$/i;

/** A changed file in both forms: git's, and the project-relative one the
 *  graph and manifest hold. */
interface ChangedPath {
  repoPath: string;
  path: string;
}

/**
 * The module-graph walk: changed files up through their importers to the
 * stories that reach them.
 *
 * Three ways it declines to narrow, each a full run with a reason:
 * - a changed file the graph has no node for (a public asset, a server file,
 *   a deleted module) could affect anything;
 * - a changed file whose importers end at a module that is not a story file
 *   (the preview, a global stylesheet it imports) runs for every story;
 * - a story whose file is not in the graph is always included, since nothing
 *   proves it unaffected.
 */
function walkModuleGraph(
  stories: StoryManifest[],
  files: ChangedPath[],
  graph: ModuleGraph,
  projectRoot: string,
  configDirs: string[],
): AffectedResult {
  const modules = graph.modules;
  const unmapped = files.filter((f) => !modules.has(f.path) && !isNeverBundled(f));
  if (unmapped.length > 0) {
    return {
      stories,
      reason: 'unmapped-change',
      detail: `${listFiles(unmapped.map((f) => f.path))} is not in the build's module graph`,
    };
  }

  const storyFiles = new Set(
    stories.map((s) => toPosixRelative(projectRoot, s.componentPath)),
  );

  // A stylesheet or asset is reached through edges parsed from source, and the
  // plugin records where it could not follow a reference. With any gap, an
  // importer of this file may be missing, so it cannot be narrowed.
  const gaps = Object.entries(graph.opaque);
  if (gaps.length > 0) {
    const asset = files.find((f) => modules.has(f.path) && !CODE_EXT.test(f.path));
    if (asset) {
      return {
        stories,
        reason: 'asset-changed',
        detail: `${asset.path} (non-JS dependency edges are not tracked completely: ${gaps[0]![0]}: ${gaps[0]![1]})`,
      };
    }
  }
  // A worker's own imports are bundled by a build the plugin never sees.
  if (graph.workers) {
    const code = files.find((f) => modules.has(f.path) && !storyFiles.has(f.path));
    if (code) {
      return {
        stories,
        reason: 'unmapped-change',
        detail: `${code.path} may be imported by a web worker, whose imports the module graph does not follow`,
      };
    }
  }

  const reverse = reverseOf(modules);
  const reached = walkDependents(
    reverse,
    files.map((f) => f.path).filter((p) => modules.has(p)),
  );

  // What runs for every story: modules under a workbench config dir (the
  // preview, which a story may import itself, as CSF factories do), and any
  // module nothing imports that is not a story or a docs page. Storybook's
  // virtual entry imports the preview and every story file, and the plugin
  // leaves virtual modules out, so the preview looks like a root from here.
  // An .mdx page is a leaf, not an entry: docs are not captured.
  const entries = [...modules.keys()]
    .filter(
      (f) =>
        isConfigChange(f, configDirs) ||
        ((reverse.get(f)?.size ?? 0) === 0 && !storyFiles.has(f) && !/\.mdx$/i.test(f)),
    )
    .sort();
  const shared = new Map<string, string>();
  for (const entry of entries) {
    for (const f of walkForward(modules, entry)) {
      if (!shared.has(f)) shared.set(f, entry);
    }
  }
  const hit = files.map((f) => f.path).filter((f) => shared.has(f));
  if (hit.length > 0) {
    const first = hit.sort()[0]!;
    const entry = shared.get(first)!;
    return {
      stories,
      reason: 'shared-entry-changed',
      detail:
        first === entry
          ? `${entry} is imported outside any story (preview, global styles), so it reaches every story`
          : `${first} is imported by ${entry}, which is imported outside any story (preview, global styles), so it reaches every story`,
    };
  }

  const matched = stories.filter((s) => {
    const rel = toPosixRelative(projectRoot, s.componentPath);
    return reached.has(rel) || !modules.has(rel);
  });
  if (matched.length === 0) {
    return {
      stories,
      reason: 'no-match-fallback',
      detail: 'the changed files reach no story in the module graph',
    };
  }
  return { stories: matched, reason: 'graph-walk' };
}

/** Everything `start` imports, itself included. */
function walkForward(modules: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const next of modules.get(f) ?? []) stack.push(next);
  }
  return seen;
}

function reverseOf(modules: Map<string, string[]>): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [importer, imports] of modules) {
    for (const imported of imports) {
      let set = reverse.get(imported);
      if (!set) reverse.set(imported, (set = new Set()));
      set.add(importer);
    }
  }
  return reverse;
}

/** A short list for a reason line: the first few, then a count. */
function listFiles(files: string[]): string {
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown;
}

/** A repository-relative path as the project-relative one the graph and
 *  manifest hold. `prefix` is the project's place in the repository
 *  (`apps/web/`, '' at the top). A file outside the project keeps a `../`
 *  path, as the plugin records modules there. */
export function repoToProjectPath(repoPath: string, prefix: string): string {
  if (prefix === '') return repoPath;
  if (repoPath.startsWith(prefix)) return repoPath.slice(prefix.length);
  return path.posix.relative(prefix.replace(/\/$/, ''), repoPath);
}

const NEVER_BUNDLED_EXT = /\.(?:md|markdown|mdown|rst|adoc)$/i;
const NEVER_BUNDLED_NAME =
  /^(?:LICENSE.*|CHANGELOG.*|AUTHORS.*|CODEOWNERS|\.gitignore|\.gitattributes|\.editorconfig)$/;

/** Files no bundler imports: prose docs, licences, git and editor dotfiles,
 *  `.github/`. `.mdx` is not one: it compiles to a module. */
export function isNeverBundled(f: ChangedPath): boolean {
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  return (
    NEVER_BUNDLED_EXT.test(name) ||
    NEVER_BUNDLED_NAME.test(name) ||
    f.repoPath.startsWith('.github/')
  );
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
    // The module graph names components the manifest's chunks hide.
    const graph = await loadModuleGraph(opts.buildDir);
    if (graph) {
      const affected = walkDependents(reverseOf(graph.modules), changed);
      const matched = stories.filter((s) =>
        affected.has(toPosixRelative(opts.projectRoot, s.componentPath)),
      );
      if (matched.length > 0) return matched;
    }
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
      const parsed: unknown = JSON.parse(
        await readFile(path.join(buildDir, rel), 'utf8'),
      );
      // Not a Vite manifest (another tool's manifest.json): no graph, which
      // escalates to capturing everything, as a missing one does.
      if (isViteManifest(parsed)) return parsed;
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
    // --no-renames: with rename detection (a user setting, `diff.renames`)
    // git lists only the new name, and a story whose file was moved away
    // lost its change. Both sides are listed instead.
    const tracked = git(
      ['diff', '--name-only', '--no-renames', '-z', sinceCommit, '--'],
      cwd,
    );
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

/** Whether `ref` names a commit, for checking `--since` before a run leans
 *  on it. A leading dash is refused: git would read it as an option. */
export function gitIsCommit(ref: string, cwd: string): boolean {
  if (ref.startsWith('-')) return false;
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
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
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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
    // The 1 MiB default holds about 15,000 changed paths of 70 bytes; a
    // vendored tree or a repo-wide rename passes that, and an overflow throws. Past this
    // larger cap the caller's catch still degrades (unknown, or a full run).
    maxBuffer: GIT_MAX_BUFFER,
  });
}

export function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
