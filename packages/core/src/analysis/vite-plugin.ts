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
// Two kinds of edge, because the bundler's own module graph (`importedIds`)
// stops at JavaScript imports. Stylesheet `@import`/`@use`/`url()`, CSS-modules
// `composes … from`, and `new URL('./x', import.meta.url)` are references the
// bundler resolves inside a plugin, so they are parsed here from the source in a
// `pre` transform. Anything seen but not resolvable (an unresolved reference, a
// preprocessor syntax not parsed, a web worker, Tailwind) is recorded as
// `opaque`: the analysis then refuses to narrow a change to a stylesheet or
// asset, because an importer edge may be missing.

import { existsSync, statSync } from 'node:fs';
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
  let startedAt = Date.now();
  let workers = false;

  const addEdge = (from: string, to: string) => {
    let set = extra.get(from);
    if (!set) extra.set(from, (set = new Set()));
    set.add(to);
  };

  return {
    name: 'juxtapose:module-graph',
    // The dev server has no bundle to observe.
    apply: 'build',
    // Before Vite's CSS and asset plugins, which consume the raw source.
    enforce: 'pre',
    buildStart() {
      // Taken before any file is read, so an edit during the build reads as
      // newer than the graph, never older.
      startedAt = Date.now();
      extra.clear();
      opaque.clear();
      workers = false;
    },
    async transform(code, id) {
      try {
        const file = sourcePath(id, root);
        if (file === null) return null;
        const found = scanReferences(file, code);
        if (found.workers) workers = true;
        if (found.opaque) opaque.set(file, found.opaque);
        for (const ref of found.refs) {
          const target = await resolveReference(this, ref, id);
          if (typeof target === 'object' && target !== null) continue;
          if (target === null) {
            opaque.set(file, `unresolved reference ${ref.spec}`);
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
        // Parsed edges to files the bundler also inlined (a stylesheet `url()`
        // asset) are modules of their own here, so they are nodes too.
        for (const [from, tos] of extra) {
          const out = (modules[from] ??= new Set());
          for (const to of tos) {
            out.add(to);
            modules[to] ??= new Set();
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
            { root, builtAt: startedAt, opaque: Object.fromEntries(opaque), workers },
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

interface Reference {
  spec: string;
  /** Sass resolves `@use 'x'` to `_x.scss`, `x/_index.scss` and so on. */
  sass: boolean;
}

interface Scan {
  refs: Reference[];
  /** Why the file's edges cannot be trusted to be complete, if so. */
  opaque?: string;
  workers?: boolean;
}

const STYLE_EXT = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|mdx)$/i;

/** References in a file the bundler's import graph does not show. Pure, so
 *  tested without a build. */
export function scanReferences(file: string, code: string): Scan {
  const refs: Reference[] = [];
  const out: Scan = { refs };
  if (STYLE_EXT.test(file)) {
    const sass = /\.(?:scss|sass)$/i.test(file);
    const bare = stripComments(code);
    for (const m of bare.matchAll(
      /@(?:import|use|forward)\s+(?:\([^)]*\)\s*)?((?:["'][^"']+["']\s*,?\s*)+|url\(\s*["']?[^)"']+["']?\s*\))/g,
    )) {
      for (const q of m[1]!.matchAll(
        /["']([^"']+)["']|url\(\s*["']?([^)"']+?)["']?\s*\)/g,
      )) {
        const spec = q[1] ?? q[2]!;
        if (!/^(?:https?:)?\/\//.test(spec) && !/^sass:/.test(spec)) {
          refs.push({ spec, sass });
        }
      }
    }
    for (const m of bare.matchAll(
      /(?<![\w-])url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s"']+))\s*\)/g,
    )) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (/^(?:data:|#|https?:|\/\/)/.test(spec) || spec.startsWith('/')) continue;
      refs.push({ spec, sass: false });
    }
    for (const m of bare.matchAll(/composes\s*:[^;{}]*?\bfrom\s+["']([^"']+)["']/g)) {
      refs.push({ spec: m[1]!, sass: false });
    }
    if (
      /\.(?:styl|stylus)$/i.test(file) &&
      /@(?:import|require)\b|^\s*(?:@import|@require)/m.test(bare)
    ) {
      out.opaque = 'stylus imports are not parsed';
    }
    // Tailwind and PostCSS plugins read files the stylesheet never names.
    if (
      /@(?:tailwind|source|config|plugin|reference)\b|@import\s+["']tailwindcss/.test(
        bare,
      )
    ) {
      out.opaque = 'tailwind reads files this stylesheet does not import';
    }
    if (
      /@import\s+(?!["'(]|url)/.test(bare) ||
      /@(?:use|forward)\s+(?!["'])/.test(bare)
    ) {
      out.opaque = 'an import with a computed path';
    }
  } else if (SCRIPT_EXT.test(file)) {
    for (const m of code.matchAll(
      /new\s+URL\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)\s*,\s*import\.meta\.url\s*\)/g,
    )) {
      refs.push({ spec: m[1] ?? m[2] ?? m[3]!, sass: false });
    }
    // A `new URL(` with a computed path (a template with `${}`) can name
    // anything under the directory.
    if (/new\s+URL\(\s*`[^`]*\$\{[^`]*`\s*,\s*import\.meta\.url/.test(code)) {
      out.opaque = 'new URL with a computed path';
    }
    // A worker is bundled by a separate build this plugin never sees.
    if (/\?(?:worker|sharedworker)\b|new\s+(?:Shared)?Worker\s*\(/.test(code)) {
      out.workers = true;
      out.opaque = 'web worker';
    }
  }
  return out;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'(])\/\/[^\n]*/g, '$1');
}

/** The file a reference names, `'external'` for one that is not a file to
 *  track (a remote URL, a dependency), null when it cannot be found. */
async function resolveReference(
  ctx: TransformContext,
  ref: Reference,
  importer: string,
): Promise<string | null | { external: true }> {
  const clean = importer.replace(/\?.*$/, '');
  const spec = ref.spec.replace(/[?#].*$/, '');
  const relative = spec.startsWith('.') || path.isAbsolute(spec);
  // Sass looks beside the importer first, for `@use 'vars'` as for './vars'.
  if (relative || ref.sass) {
    const base = path.resolve(path.dirname(clean), spec);
    for (const candidate of candidates(base, ref.sass)) {
      if (existsSync(candidate) && !isDir(candidate)) return candidate;
    }
  }
  const viaBundler = await ctx
    .resolve(relative ? spec : ref.spec, importer)
    .catch(() => null);
  if (viaBundler && !viaBundler.external) return viaBundler.id;
  // A bare name that is not a file: a package (`@import 'bootstrap'`), left to
  // the dependency rules.
  if (!relative && !ref.sass && viaBundler?.external) return { external: true };
  if (!relative && existsNodeModule(clean, spec)) return { external: true };
  return null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** What Sass and Less try for `@use 'x'`: the name, a partial, an extension,
 *  a folder index. */
function candidates(base: string, sass: boolean): string[] {
  const dir = path.dirname(base);
  const name = path.basename(base);
  const list = [base];
  if (sass) {
    for (const ext of ['.scss', '.sass', '.css']) {
      list.push(base + ext, path.join(dir, `_${name}${ext}`));
      list.push(path.join(base, `index${ext}`), path.join(base, `_index${ext}`));
    }
  } else {
    for (const ext of ['.css', '.less', '.styl']) list.push(base + ext);
  }
  return list;
}

function existsNodeModule(from: string, spec: string): boolean {
  const pkg = spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : spec.split('/')[0]!;
  let dir = path.dirname(from);
  for (;;) {
    if (existsSync(path.join(dir, 'node_modules', pkg))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
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
