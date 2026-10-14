// `@juxtapose/core/vite`: the Vite plugin that records the source-module
// import graph at build time, so `jux run --since` can tell which stories a
// changed component reaches. See module-graph.ts for why the build manifest
// is not enough.
//
// The Storybook addon adds this itself. Ladle (or a plain Vite workbench)
// adds it to its vite.config:
//
//   import { juxtaposeModuleGraph } from '@juxtapose/core/vite';
//   export default { plugins: [juxtaposeModuleGraph()] };
//
// It only observes: it transforms nothing, so it cannot change what a story
// renders.

import path from 'node:path';
import { MODULE_GRAPH_FILE, serializeModuleGraph } from './module-graph.js';

/** The slice of Rollup's plugin context this reads, declared here so core does
 *  not depend on vite's types. */
interface BuildContext {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): {
    importedIds: readonly string[];
    dynamicallyImportedIds: readonly string[];
  } | null;
  emitFile(file: { type: 'asset'; fileName: string; source: string }): string;
  warn(message: string): void;
}

export interface JuxtaposeVitePlugin {
  name: string;
  apply: 'build';
  generateBundle(this: BuildContext): void;
}

export interface ModuleGraphPluginOptions {
  /** The directory paths are recorded relative to: the one `jux run` is
   *  started in. Default `JUXTAPOSE_ROOT`, then the working directory. */
  root?: string;
}

export function juxtaposeModuleGraph(
  opts: ModuleGraphPluginOptions = {},
): JuxtaposeVitePlugin {
  const root = path.resolve(opts.root ?? process.env.JUXTAPOSE_ROOT ?? process.cwd());
  return {
    name: 'juxtapose:module-graph',
    // The dev server has no bundle to observe.
    apply: 'build',
    generateBundle() {
      const modules: Record<string, Set<string>> = {};
      for (const id of this.getModuleIds()) {
        const file = sourcePath(id, root);
        if (file === null) continue;
        const info = this.getModuleInfo(id);
        if (!info) {
          // Not writing is the safe direction: a missing graph escalates to
          // the manifest and then to a full run, a partial one would not.
          this.warn(
            'juxtapose: the bundler did not describe a module, so no module graph was written and `jux run --since` will capture every story.',
          );
          return;
        }
        const out = (modules[file] ??= new Set());
        for (const dep of [...info.importedIds, ...info.dynamicallyImportedIds]) {
          const rel = sourcePath(dep, root);
          if (rel !== null && rel !== file) out.add(rel);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: MODULE_GRAPH_FILE,
        source: serializeModuleGraph(
          Object.fromEntries(
            Object.keys(modules)
              .sort()
              .map((k) => [k, [...modules[k]!].sort()]),
          ),
        ),
      });
    },
  };
}

/** A module id as a project-relative posix path, or null for a module that is
 *  not a file the developer edits: a virtual module (`\0…`, `virtual:…`), a
 *  dependency under node_modules (a change there arrives as a lockfile
 *  change), or anything that is not an absolute path. The `?query` Vite adds
 *  (`?inline`, `?raw`, `?import`) names the same file. */
export function sourcePath(id: string, root: string): string | null {
  if (id.startsWith('\0')) return null;
  const file = id.replace(/\?.*$/, '');
  if (!path.isAbsolute(file) || /(^|\/)virtual:/.test(file)) return null;
  if (file.split(path.sep).includes('node_modules')) return null;
  return path.relative(root, file).split(path.sep).join('/');
}
