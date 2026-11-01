import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import MagicString, { type SourceMap } from 'magic-string';
import { installSvelteComponentRegistry } from '../capture/svelte-component-runtime.js';
import { gitTopLevel } from './affected.js';

interface SvelteCompiler {
  VERSION: string;
  parse(source: string, options: { modern: true }): unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const SVELTE_COMPONENT_RUNTIME = 'virtual:juxtapose-svelte-components';
const resolvedRuntime = '\0' + SVELTE_COMPONENT_RUNTIME;

/** Public project compiler only. React/Vue users do not acquire a Svelte dependency. */
export function loadSvelteComponentCompiler(root: string): SvelteCompiler | null {
  try {
    const value: unknown = createRequire(path.join(path.resolve(root), 'package.json'))(
      'svelte/compiler',
    );
    if (
      !object(value) ||
      typeof value['VERSION'] !== 'string' ||
      !/^5\./.test(value['VERSION']) ||
      typeof value['parse'] !== 'function'
    )
      return null;
    const parse = value['parse'] as SvelteCompiler['parse'];
    return {
      VERSION: value['VERSION'],
      parse(source, options) {
        const result: unknown = parse(source, options);
        return result;
      },
    };
  } catch {
    return null;
  }
}

/** Never use the compiler/project root as an unverified repository coordinate. */
function componentSourceFile(
  filename: string,
  repositoryRoot: string | null,
): string | null {
  if (!repositoryRoot) return null;
  try {
    const relative = path
      .relative(repositoryRoot, realpathSync(filename))
      .split(path.sep)
      .join('/');
    return relative.length > 0 &&
      relative.length <= 512 &&
      !path.isAbsolute(relative) &&
      !relative
        .split('/')
        .some((part) => !part || ['.', '..', 'node_modules', '.git'].includes(part)) &&
      !/[\\:%?#]/.test(relative) &&
      ![...relative].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ? relative
      : null;
  } catch {
    return null;
  }
}

/** Source transformation is deliberately separate from compilation: dev remains false. */
export function instrumentSvelteComponent(
  source: string,
  filename: string,
  repositoryRoot: string | null,
  compiler: SvelteCompiler,
): { code: string; map: SourceMap } | null {
  if (!filename.endsWith('.svelte') || filename.includes('?') || filename.includes('\0'))
    return null;
  const ast = compiler.parse(source, { modern: true });
  if (!object(ast) || !object(ast['fragment']))
    throw new Error('Unsupported Svelte component AST.');
  let suffix = 0;
  while (source.includes(`__jux_svelte_${suffix}`)) suffix++;
  const prefix = `__jux_svelte_${suffix}`;
  const file = componentSourceFile(filename, repositoryRoot);
  const name = path.basename(filename, '.svelte');
  const setup = `import{getContext as ${prefix}get,setContext as ${prefix}set,onDestroy as ${prefix}onDestroy}from'svelte';import{registry as ${prefix}registry}from'${SVELTE_COMPONENT_RUNTIME}';const ${prefix}id=${prefix}registry.register(${JSON.stringify(name)},${JSON.stringify(file)},${prefix}get(${prefix}registry.contextKey));${prefix}set(${prefix}registry.contextKey,${prefix}id);${prefix}onDestroy(()=>${prefix}registry.destroy(${prefix}id));function ${prefix}action(element){return ${prefix}registry.own(element,${prefix}id)}`;
  const insertions: [number, string][] = [];
  const instance = ast['instance'];
  if (
    object(instance) &&
    object(instance['content']) &&
    Number.isInteger(instance['content']['start'])
  )
    insertions.push([Number(instance['content']['start']), setup]);
  else if (instance === null || instance === undefined)
    insertions.push([0, `<script>${setup}</script>`]);
  else throw new Error('Unsupported Svelte instance script.');
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!object(value) || seen.has(value)) return;
    seen.add(value);
    if (value['type'] === 'RegularElement' || value['type'] === 'SvelteElement') {
      const start = value['start'];
      if (!Number.isInteger(start) || Number(start) < 0 || Number(start) >= source.length)
        throw new Error('Unsupported Svelte element location.');
      const tag = /^<[^\s/>]+/.exec(source.slice(Number(start)));
      if (!tag) throw new Error('Unsupported Svelte element opening tag.');
      insertions.push([Number(start) + tag[0].length, ` use:${prefix}action`]);
    }
    for (const [key, child] of Object.entries(value)) {
      if (['metadata', 'parent', 'loc'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(ast['fragment']);
  const code = new MagicString(source);
  for (const [position, text] of insertions) code.appendLeft(position, text);
  // Preserve consumer debugging without embedding source contents in our map/evidence.
  return {
    code: code.toString(),
    map: code.generateMap({ hires: true, source: filename, includeContent: false }),
  };
}

/** Prepend before vite-plugin-svelte; only client component source is instrumented. */
export function svelteComponentInstrumentation(root: string) {
  let compiler: SvelteCompiler | null = null;
  let repositoryRoot: string | null = null;
  return {
    name: 'juxtapose-svelte-component-evidence',
    enforce: 'pre' as const,
    buildStart() {
      compiler = loadSvelteComponentCompiler(root);
      repositoryRoot = null;
      // Resolve once per build; package-local compiler/config roots stay unchanged.
      const topLevel = compiler ? gitTopLevel(root) : null;
      if (topLevel) {
        try {
          repositoryRoot = realpathSync(topLevel);
        } catch {
          // Sources remain optional when the checkout cannot be verified.
        }
      }
    },
    resolveId(id: string) {
      return id === SVELTE_COMPONENT_RUNTIME ? resolvedRuntime : undefined;
    },
    load(id: string) {
      if (id !== resolvedRuntime || !compiler) return undefined;
      return `const install=${installSvelteComponentRegistry.toString()};export const registry=install(${JSON.stringify(compiler.VERSION)});`;
    },
    transform(source: string, id: string, options?: { ssr?: boolean }) {
      if (!compiler || options?.ssr || !id.endsWith('.svelte')) return null;
      return instrumentSvelteComponent(source, id, repositoryRoot, compiler);
    },
  };
}
