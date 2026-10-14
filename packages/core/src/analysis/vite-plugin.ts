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
// renders, and it never fails a build (any error means no graph is written,
// which escalates to a full run).
//
// What it records is the graph of script modules: the bundler's own
// `importedIds`, plus `new URL('./x', import.meta.url)`, which the bundler turns
// into an asset reference rather than an import. It does NOT reconstruct
// stylesheet edges (`@import`, `@use`, `url()`, `composes`): other plugins
// (Tailwind, PostCSS, Sass) rewrite those before this could see them, so the
// analysis never narrows a change to a stylesheet or asset instead.
//
// Anything seen that edges cannot describe (a worker or worklet, which a
// separate build bundles, or a computed `new URL` path) is recorded as
// `opaque`, and then no change is narrowed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MODULE_GRAPH_FILE, serializeModuleGraph } from './module-graph.js';

interface ResolvedId {
  id: string;
  external?: boolean | string;
}

/** The slice of Rollup's plugin context this reads, declared here so core does
 *  not depend on vite's types. */
interface BuildContext {
  getModuleIds(): Iterable<string>;
  getModuleInfo(id: string): {
    importedIds: readonly string[];
    dynamicallyImportedIds: readonly string[];
  } | null;
  getWatchFiles?(): string[];
  emitFile(file: { type: 'asset'; fileName: string; source: string }): string;
  warn(message: string): void;
}

interface TransformContext {
  resolve(source: string, importer: string): Promise<ResolvedId | null>;
}

export interface JuxtaposeVitePlugin {
  name: string;
  apply: 'build';
  enforce: 'pre';
  configResolved(config: { build?: { cssCodeSplit?: boolean } }): void;
  buildStart(this: unknown): void;
  transform(this: TransformContext, code: string, id: string): Promise<null>;
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
  /** Edges found by parsing, beside the bundler's own. */
  const extra = new Map<string, Set<string>>();
  const opaque = new Map<string, string>();
  /** sha256 of each source file as the build read it. */
  const hashes = new Map<string, string>();
  let startedAt = Date.now();
  let workers = false;
  let cssCodeSplit = true;

  const addEdge = (from: string, to: string) => {
    let set = extra.get(from);
    if (!set) extra.set(from, (set = new Set()));
    set.add(to);
  };

  return {
    name: 'juxtapose:module-graph',
    // The dev server has no bundle to observe.
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      cssCodeSplit = config.build?.cssCodeSplit !== false;
    },
    buildStart() {
      startedAt = Date.now();
      extra.clear();
      opaque.clear();
      hashes.clear();
      workers = false;
    },
    async transform(code, id) {
      try {
        const file = sourcePath(id, root);
        if (file === null) return null;
        // Hashed from disk as the module is first read, not at the end of the
        // build, so an edit made mid-build reads as different from the graph.
        // Not from `code`: an earlier plugin may have rewritten that.
        if (!hashes.has(file) && !/\?/.test(id)) {
          const h = hashFile(id);
          if (h) hashes.set(file, h);
        }
        const found = scanReferences(file, code);
        if (found.workers) workers = true;
        if (found.opaque) opaque.set(file, found.opaque);
        for (const spec of found.urls) {
          const target = await resolveUrl(this, spec, id);
          if (target === null) {
            opaque.set(file, `unresolved new URL('${spec}', import.meta.url)`);
            continue;
          }
          const rel = sourcePath(target, root);
          if (rel !== null && rel !== file) addEdge(file, rel);
        }
      } catch (err) {
        const file = sourcePath(id, root);
        if (file !== null) opaque.set(file, `could not scan: ${String(err)}`);
      }
      return null;
    },
    generateBundle() {
      try {
        const modules: Record<string, Set<string>> = {};
        for (const id of this.getModuleIds()) {
          const file = sourcePath(id, root);
          if (file === null) {
            // A virtual module made by a plugin can read files from disk and
            // import others by name; none of that is followed.
            if (isForeignVirtual(id)) {
              opaque.set(
                `virtual:${id.replace(/^\0/, '')}`,
                'virtual module from a build plugin',
              );
            }
            continue;
          }
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
        // Referenced files are nodes too (an asset a script points at).
        for (const [from, tos] of extra) {
          const out = (modules[from] ??= new Set());
          for (const to of tos) {
            out.add(to);
            modules[to] ??= new Set();
          }
        }
        // Files the build read that no module accounts for: a plugin's `load`
        // reading a file to build a virtual module. Changing one changes
        // output without an import edge.
        const external: string[] = [];
        for (const abs of this.getWatchFiles?.() ?? []) {
          const rel = sourcePath(abs, root);
          if (rel !== null && !(rel in modules)) external.push(rel);
        }
        // Anything the transform did not see (a module another plugin
        // loaded) is hashed now.
        for (const file of Object.keys(modules)) {
          if (hashes.has(file)) continue;
          const h = hashFile(path.resolve(root, file));
          if (h) hashes.set(file, h);
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
            {
              root,
              builtAt: startedAt,
              opaque: Object.fromEntries(opaque),
              workers,
              external: [...new Set(external)].sort(),
              cssCodeSplit,
              hashes: Object.fromEntries(
                [...hashes]
                  .filter(([k]) => k in modules)
                  .sort(([a], [b]) => (a < b ? -1 : 1)),
              ),
            },
          ),
        });
      } catch (err) {
        this.warn(
          `juxtapose: could not write the module graph (${String(err)}); \`jux run --since\` will capture every story.`,
        );
      }
    },
  };
}

/** Virtual modules Vite, Storybook, Ladle and this plugin make themselves;
 *  any other is a user plugin's, whose reads and imports are not visible. */
const OWN_VIRTUAL =
  /^\0?\/?(?:vite\/|vite:|commonjs|rolldown|rollup|plugin-vue:|virtual:\/?@storybook|virtual:\/?@juxtapose|virtual:generated-list|virtual:ladle|@storybook|__vite|juxtapose)|\?commonjs|builder-vite|@storybook\/|\/@ladle\//;

export function isForeignVirtual(id: string): boolean {
  if (!id.startsWith('\0') && !/(^|\/)virtual:/.test(id)) return false;
  return !OWN_VIRTUAL.test(id);
}

/** sha256 of a file's bytes, or null when it cannot be read. */
export function hashFile(file: string): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(file.replace(/\?.*$/, '')))
      .digest('hex');
  } catch {
    return null;
  }
}

interface Scan {
  /** `new URL('<spec>', import.meta.url)` literals. */
  urls: string[];
  /** Why the file's edges cannot be trusted to be complete, if so. */
  opaque?: string;
  workers?: boolean;
}

const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx)$/i;

/** Where a script points at files the bundler graph does not show, or at code
 *  a separate build bundles. Pure, so tested without a build. */
export function scanReferences(file: string, code: string): Scan {
  const out: Scan = { urls: [] };
  if (!SCRIPT_EXT.test(file)) return out;
  for (const m of code.matchAll(
    /new\s+URL\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)\s*,\s*import\.meta\.url\s*\)/g,
  )) {
    out.urls.push(m[1] ?? m[2] ?? m[3]!);
  }
  // A `new URL(` with a computed path can name anything under the directory.
  if (/new\s+URL\(\s*`[^`]*\$\{[^`]*`\s*,\s*import\.meta\.url/.test(code)) {
    out.opaque = 'new URL with a computed path';
  }
  // Workers and worklets are bundled by a separate build this plugin never
  // sees, so their imports are missing from the graph.
  const worker =
    /\?(?:worker|sharedworker)\b|new\s+(?:Shared)?Worker\s*\(|\.(?:paintWorklet|audioWorklet|animationWorklet|layoutWorklet)\b|\.addModule\s*\(|serviceWorker\s*\.\s*register\s*\(|\bSharedWorker\b/;
  if (worker.test(code)) {
    out.workers = true;
    out.opaque = 'web worker or worklet';
  }
  return out;
}

/** The file a `new URL` literal names, or null when it cannot be found. */
async function resolveUrl(
  ctx: TransformContext,
  spec: string,
  importer: string,
): Promise<string | null> {
  const clean = spec.replace(/[?#].*$/, '');
  if (clean.startsWith('.') || path.isAbsolute(clean)) {
    const file = path.resolve(path.dirname(importer.replace(/\?.*$/, '')), clean);
    if (existsSync(file)) return file;
  }
  const viaBundler = await ctx.resolve(spec, importer).catch(() => null);
  return viaBundler && !viaBundler.external ? viaBundler.id : null;
}

/** A module id as a project-relative posix path, or null for a module that is
 *  not a file the developer edits: a virtual module (`\0…`, `virtual:…`), a
 *  dependency under node_modules (a change there arrives as a lockfile
 *  change), or anything that is not an absolute path. The `?query` Vite adds
 *  (`?inline`, `?raw`, `?import`) names the same file. */
export function sourcePath(id: string, root: string): string | null {
  if (id.startsWith('\0')) return null;
  // Vite ids use `/` on Windows too, so normalize before any segment test.
  const file = id.replace(/\?.*$/, '').replace(/\\/g, '/');
  if (!path.isAbsolute(file) && !/^[A-Za-z]:\//.test(file)) return null;
  if (/(^|\/)virtual:/.test(file)) return null;
  if (file.split('/').includes('node_modules')) return null;
  return path.relative(root, file).split(path.sep).join('/');
}
