// Why did this story change? The cheap link only: the story's import
// closure — a forward walk over the same Vite manifest `affected.ts` walks
// backwards — intersected with the files changed since `--since`, nearest
// first. `none-in-closure` beside `render-drift` is the strongest "this is
// not your code" the tool can give. Matched CSS rules and source lines are
// later rows.
//
// "Not your code" is said only after a full trace. A Storybook build
// bundles components into chunks that have no `src` in the manifest, so a
// story's closure usually ends in an unresolved node; a changed file found
// before that point is a hit, but no hit is `unknown`, never
// `none-in-closure`. The first draft said "not your code" for a component
// edit on examples/storybook, the worst answer the feature can give.
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

export interface CauseSources {
  projectRoot: string;
  configDirs: string[];
  /** Posix paths relative to projectRoot (git's top-level-relative paths
   *  already mapped); null when git could not say. */
  changedFiles: string[] | null;
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
): string[] | null {
  if (files === null || topLevel === null) return null;
  const root = realpathSync(projectRoot);
  return files.map((f) => toPosixRelative(root, path.join(topLevel, f)));
}

/** src → the srcs (or bare chunk keys) it imports, static and dynamic. */
interface ForwardGraph {
  edges: Map<string, string[]>;
  /** Manifest keys with no `src`: a node here means the walk cannot see
   *  through it. */
  unresolved: Set<string>;
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
    .filter((f) => isLockfileChange(f) || isConfigChange(f, src.configDirs))
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
  const changed = new Set(src.changedFiles);
  const files = [...reach]
    .filter(([file]) => changed.has(file))
    .map(([path, distance]) => ({ path, distance }))
    .sort((x, y) => x.distance - y.distance || compareCodeUnits(x.path, y.path))
    .slice(0, MAX_CAUSE_FILES);
  if (files.length > 0) return { kind: 'in-closure', files };
  // No hit. Honest only if every node on the way had a src to look through.
  for (const node of reach.keys()) if (graph.unresolved.has(node)) return UNKNOWN;
  return { kind: 'none-in-closure', files: [] };
}

/** Edges resolve through the same key → src map affected.ts's reverse graph
 *  uses; a key with no src is kept as a node (so the walk can report it as
 *  unresolved) with no outgoing edges. */
function buildForwardGraph(manifest: ViteManifest): ForwardGraph {
  const srcOf = keyToSrc(manifest);
  const edges = new Map<string, string[]>();
  const unresolved = new Set<string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.src) {
      unresolved.add(key);
      continue;
    }
    edges.set(
      entry.src,
      [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])].map(
        (k) => srcOf.get(k) ?? k,
      ),
    );
  }
  return { edges, unresolved };
}

/** BFS distance from `start` to everything it reaches, `start` at 0. */
function closure(edges: Map<string, string[]>, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let k = 0; k < queue.length; k++) {
    const file = queue[k];
    const d = dist.get(file)!;
    for (const next of edges.get(file) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}
