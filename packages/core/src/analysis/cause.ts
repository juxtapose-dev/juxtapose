// Why did this story change? The cheap link only: the story's import
// closure — a forward walk over the same Vite manifest `affected.ts` walks
// backwards — intersected with the files changed since `--since`, nearest
// first. `none-in-closure` beside `render-drift` is the strongest "this is
// not your code" the tool can give. Matched CSS rules and source lines are
// later rows.
//
// "Not your code" is said only after a full trace, and the manifest is
// chunk-level, so a full trace needs two things:
//
// - Every node the walk reaches has its own manifest entry with a `src`. A
//   Storybook build bundles components into chunks that have none, so a
//   story's closure usually ends in an unresolved node; an `imports[]` key
//   with no entry at all is the same. A changed file found before that point
//   is a hit, but no hit is `unknown`. The first draft said "not your code"
//   for a component edit on examples/storybook, the worst answer the
//   feature can give.
// - Every changed file is some entry's `src`. A module Rollup inlined into
//   a chunk has no entry of its own, so a changed file the manifest never
//   names could sit inside any chunk, this story's included. That holds for
//   far more than code: JSON, SVG, GraphQL, `?raw` text, images and .mdx are
//   all importable. So the exemption is an allowlist of files no bundler
//   imports (prose docs, licences, git and editor dotfiles, `.github/`), and
//   anything else unnamed blocks the claim. A list of bundled extensions
//   failed open: every importable type it missed was a false "not yours".
//
// Even then the claim is about the traced imports, not about every byte the
// story renders (a stylesheet linked from preview-head, a public asset), so
// the wording says "likely".
//
// Nothing here may fail a story. `prepareCause` reads git and the manifest
// on the first `causeFor` call, once, inside try/catch; that call happens
// only in the fail branch of `judge()`, so a green run reads neither.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { compareCodeUnits } from '../diff/structural/deltas.js';
import { MAX_CAUSE_FILES } from '../diff/structural.js';
import type { Cause } from '../types.js';
import {
  gitChangedFiles,
  gitTopLevel,
  isConfigChange,
  isLockfileChange,
  isNeverBundled,
  isTsconfigChange,
  keyToSrc,
  loadViteManifest,
  toPosixRelative,
  type ViteManifest,
} from './affected.js';

export interface CauseIndex {
  /** The cause for one story's component path. Never throws, never reads
   *  anything before the first call. */
  causeFor(componentPath: string): Promise<Cause>;
}

/** One changed file, in both forms the rules need. */
export interface ChangedFile {
  /** Posix, relative to the project root: what a manifest `src` holds. */
  path: string;
  /** As git prints it, relative to the repository top level. In a monorepo
   *  only this form shows that `../../pnpm-lock.yaml` is the root lockfile. */
  repoPath: string;
}

export interface CauseSources {
  projectRoot: string;
  configDirs: string[];
  /** Null when git could not say. */
  changedFiles: ChangedFile[] | null;
  manifest: ViteManifest | null;
}

const UNKNOWN: Cause = { kind: 'unknown', files: [] };

/** The index from already-loaded inputs. Pure. */
export function buildCauseIndex(src: CauseSources): CauseIndex {
  const graph = src.manifest ? buildForwardGraph(src.manifest) : null;
  return {
    causeFor: async (componentPath) => causeOf(src, graph, componentPath),
  };
}

/** The index for `jux run --since`. Lazy and memoized, so the manifest and
 *  git are read once, and only if some story fails. */
export function prepareCause(opts: {
  projectRoot: string;
  buildDir?: string;
  sinceCommit: string;
  configDirs: string[];
}): CauseIndex {
  let loading: Promise<CauseIndex> | undefined;
  const load = async (): Promise<CauseIndex> =>
    buildCauseIndex({
      projectRoot: opts.projectRoot,
      configDirs: opts.configDirs,
      manifest: await orNull(() =>
        opts.buildDir ? loadViteManifest(opts.buildDir) : Promise.resolve(null),
      ),
      changedFiles: await orNull(async () =>
        projectRelative(
          gitChangedFiles(opts.sinceCommit, opts.projectRoot),
          gitTopLevel(opts.projectRoot),
          opts.projectRoot,
        ),
      ),
    });
  return {
    causeFor: async (componentPath) => {
      try {
        loading ??= load();
        return await (await loading).causeFor(componentPath);
      } catch {
        return UNKNOWN;
      }
    },
  };
}

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Git prints paths relative to the repository top level; the manifest's
 *  `src` is relative to the project root. In a monorepo these differ
 *  (`examples/storybook/stories/X.jsx` vs `stories/X.jsx`), and comparing
 *  them unmapped made every story `none-in-closure`. A file outside the
 *  project maps to a `../` path, which is still what the manifest would hold
 *  for it.
 *
 *  Git prints its top level with symlinks resolved, so the project root is
 *  resolved too: on macOS the temp dir `/var/folders/…` is
 *  `/private/var/folders/…` to git, and relating the two unresolved paths
 *  gave `../../../../private/var/…` for every file, which matched nothing
 *  and made a component edit `none-in-closure`. */
function projectRelative(
  files: string[] | null,
  topLevel: string | null,
  projectRoot: string,
): ChangedFile[] | null {
  if (files === null || topLevel === null) return null;
  const root = realpathSync(projectRoot);
  return files.map((repoPath) => ({
    path: toPosixRelative(root, path.join(topLevel, repoPath)),
    repoPath,
  }));
}

interface ForwardGraph {
  /** src → the srcs (or bare chunk keys) it imports, static and dynamic.
   *  A node that is not a key here is one the walk cannot look inside. */
  edges: Map<string, string[]>;
}

const neverBundled = isNeverBundled;

/** Reaches every story: a root lockfile or tsconfig, or a workbench config
 *  dir. Checked in both forms, since a monorepo's root files are only
 *  recognisable in git's. */
function isGlobalChange(f: ChangedFile, configDirs: string[]): boolean {
  return [f.path, f.repoPath].some(
    (p) => isLockfileChange(p) || isTsconfigChange(p) || isConfigChange(p, configDirs),
  );
}

function causeOf(
  src: CauseSources,
  graph: ForwardGraph | null,
  componentPath: string,
): Cause {
  if (src.changedFiles === null) return UNKNOWN;
  // Same rule as resolveAffected: these reach every story, so the closure
  // is beside the point.
  const global = src.changedFiles
    .filter((f) => isGlobalChange(f, src.configDirs))
    .map((f) => f.path)
    .sort(compareCodeUnits);
  if (global.length > 0) {
    return {
      kind: 'config',
      files: global.slice(0, MAX_CAUSE_FILES).map((path) => ({ path, distance: 0 })),
    };
  }
  if (!graph || componentPath === '') return UNKNOWN;
  const start = toPosixRelative(src.projectRoot, componentPath);
  // Not in the graph (urls platform, a story outside the build): the
  // closure was never traced, so "none of your files" would be a guess.
  if (!graph.edges.has(start)) return UNKNOWN;
  const reach = closure(graph.edges, start);
  const changed = new Set(src.changedFiles.map((f) => f.path));
  const files = [...reach]
    .filter(([file]) => changed.has(file))
    .map(([path, distance]) => ({ path, distance }))
    .sort((x, y) => x.distance - y.distance || compareCodeUnits(x.path, y.path))
    .slice(0, MAX_CAUSE_FILES);
  // Fully traced: every node on the way had a src to look through, and no
  // changed module could be hiding inlined in a chunk. A hit without it is
  // still a hit, but not the whole answer: on examples/storybook a token edit
  // bundled into the component chunk, beside a label edit in the story,
  // named only the story file, for stories the token had changed.
  const traced =
    [...reach.keys()].every((node) => graph.edges.has(node)) &&
    src.changedFiles.every((f) => neverBundled(f) || graph.edges.has(f.path));
  if (files.length > 0)
    return traced
      ? { kind: 'in-closure', files }
      : { kind: 'in-closure', files, partial: true };
  return traced ? { kind: 'none-in-closure', files: [] } : UNKNOWN;
}

/** Edges resolve through the same key → src map affected.ts's reverse graph
 *  uses. A key with no src (a bundled chunk) or no entry at all stays a bare
 *  key: reachable, never a key of `edges`. Entries that share a src (one
 *  module emitted twice) merge their edges; overwriting dropped the first
 *  entry's imports and could make a hit look like `none-in-closure`. */
function buildForwardGraph(manifest: ViteManifest): ForwardGraph {
  const srcOf = keyToSrc(manifest);
  const edges = new Map<string, string[]>();
  for (const entry of Object.values(manifest)) {
    if (!entry.src) continue;
    const out = [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])].map(
      (k) => srcOf.get(k) ?? k,
    );
    edges.set(entry.src, [...(edges.get(entry.src) ?? []), ...out]);
  }
  return { edges };
}

/** BFS distance from `start` to everything it reaches, `start` at 0. */
function closure(edges: Map<string, string[]>, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  // The array iterator rereads length, so files pushed below are visited too.
  for (const file of queue) {
    const d = dist.get(file)!;
    for (const next of edges.get(file) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}
