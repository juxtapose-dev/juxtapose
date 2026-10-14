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

/** `importer → modules it imports` (static and dynamic), project-relative. */
export type ModuleGraph = Map<string, string[]>;

interface ModuleGraphFile {
  version: 1;
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
    return new Map(Object.entries(parsed.modules));
  } catch {
    return null;
  }
}

function isModuleGraphFile(v: unknown): v is ModuleGraphFile {
  return (
    isRecord(v) &&
    v['version'] === 1 &&
    isRecord(v['modules']) &&
    Object.values(v['modules']).every(isStringArray)
  );
}

export function serializeModuleGraph(modules: Record<string, string[]>): string {
  const file: ModuleGraphFile = { version: 1, modules };
  return JSON.stringify(file);
}
