// The source-module import graph of a Vite build, written at build time and
// read by `affected.ts`.
//
// Why a second file beside Vite's own manifest: the manifest lists chunks.
// Rollup bundles shared component code into chunks that have no `src` and no
// list of the modules inside, so a changed component file appears nowhere in
// it and every `--since` run fell back to capturing everything (#200). The
// bundler knows the real module graph while it builds, so this plugin writes
// it out: every source module and the modules it imports, one entry each.
//
// Paths are posix and relative to the jux project root (the directory
// `jux run` is started in, or `JUXTAPOSE_ROOT`), the form `affected.ts`
// compares changed files in. A module outside the root keeps a `../` path.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord, isStringArray } from '../browser/guards.js';

/** Where the plugin writes the graph, inside the build output directory and
 *  beside Vite's `.vite/manifest.json`. */
export const MODULE_GRAPH_FILE = '.vite/juxtapose-modules.json';

/** What the build knew about itself, beside the edges. */
export interface ModuleGraphMeta {
  /** The directory every path is relative to, absolute. A graph read by a run
   *  from another root would compare unrelated paths. */
  root: string;
  /** When the build started (ms since the epoch). A source file modified later
   *  is not what the graph describes. */
  builtAt: number;
  /** Modules whose references the plugin saw but could not follow, with why.
   *  A changed stylesheet or asset cannot be narrowed when this is non-empty:
   *  an importer edge to it may be missing. */
  opaque: Record<string, string>;
  /** A web worker is bundled by a separate build the plugin never sees. */
  workers: boolean;
}

/** `importer → modules it imports` (static and dynamic), project-relative. */
export interface ModuleGraph extends ModuleGraphMeta {
  modules: Map<string, string[]>;
}

interface ModuleGraphFile extends ModuleGraphMeta {
  version: 2;
  modules: Record<string, string[]>;
}

/** Null when absent or not a graph this version understands. An unreadable
 *  graph escalates to the manifest, then to a full run: the caller never
 *  treats null as "nothing imports anything". */
export async function loadModuleGraph(buildDir: string): Promise<ModuleGraph | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(buildDir, MODULE_GRAPH_FILE), 'utf8'),
    );
    if (!isModuleGraphFile(parsed)) return null;
    return {
      root: parsed.root,
      builtAt: parsed.builtAt,
      opaque: parsed.opaque,
      workers: parsed.workers,
      modules: new Map(Object.entries(parsed.modules)),
    };
  } catch {
    return null;
  }
}

function isModuleGraphFile(v: unknown): v is ModuleGraphFile {
  return (
    isRecord(v) &&
    v['version'] === 2 &&
    typeof v['root'] === 'string' &&
    typeof v['builtAt'] === 'number' &&
    typeof v['workers'] === 'boolean' &&
    isRecord(v['opaque']) &&
    Object.values(v['opaque']).every((x) => typeof x === 'string') &&
    isRecord(v['modules']) &&
    Object.values(v['modules']).every(isStringArray)
  );
}

export function serializeModuleGraph(
  modules: Record<string, string[]>,
  meta: Partial<ModuleGraphMeta> & { root: string },
): string {
  const file: ModuleGraphFile = {
    version: 2,
    root: meta.root,
    builtAt: meta.builtAt ?? Date.now(),
    opaque: meta.opaque ?? {},
    workers: meta.workers ?? false,
    modules,
  };
  return JSON.stringify(file);
}
