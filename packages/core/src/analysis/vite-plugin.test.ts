import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { juxtaposeModuleGraph, scanReferences, sourcePath } from './vite-plugin.js';
import { MODULE_GRAPH_FILE } from './module-graph.js';

const root = path.resolve('/work/app');
const abs = (p: string) => path.join(root, p);

interface Info {
  importedIds: string[];
  dynamicallyImportedIds: string[];
}

/** Drives the hooks with a fake Rollup context; real builds are checked on
 *  the examples. */
function generate(modules: Record<string, Info | null>, pluginRoot = root) {
  const emitted: { fileName: string; source: string }[] = [];
  const warnings: string[] = [];
  const plugin = juxtaposeModuleGraph({ root: pluginRoot });
  plugin.buildStart.call(undefined);
  plugin.generateBundle.call({
    getModuleIds: () => Object.keys(modules),
    getModuleInfo: (id: string) => modules[id] ?? null,
    emitFile: (f) => {
      emitted.push(f);
      return 'ref';
    },
    warn: (m) => warnings.push(m),
  });
  return { emitted, warnings };
}

describe('juxtaposeModuleGraph', () => {
  it('writes each source module with the modules it imports, project-relative', () => {
    const { emitted } = generate({
      [abs('stories/A.stories.tsx')]: {
        importedIds: [abs('ui/A.tsx'), '/work/other/pkg.ts'],
        dynamicallyImportedIds: [abs('ui/Lazy.tsx')],
      },
      [abs('ui/A.tsx')]: {
        importedIds: [abs('ui/a.css?inline')],
        dynamicallyImportedIds: [],
      },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fileName).toBe(MODULE_GRAPH_FILE);
    const file = JSON.parse(emitted[0]!.source);
    expect(file).toMatchObject({
      version: 2,
      root,
      workers: false,
      opaque: {},
      modules: {
        'stories/A.stories.tsx': ['../other/pkg.ts', 'ui/A.tsx', 'ui/Lazy.tsx'],
        'ui/A.tsx': ['ui/a.css'],
      },
    });
    expect(file.builtAt).toBeLessThanOrEqual(Date.now());
  });

  it('leaves out virtual modules and dependencies', () => {
    const { emitted } = generate({
      '\0vite/preload-helper': { importedIds: [], dynamicallyImportedIds: [] },
      '/virtual:/@storybook/builder-vite/vite-app.js': {
        importedIds: [abs('stories/A.stories.tsx')],
        dynamicallyImportedIds: [],
      },
      [abs('node_modules/react/index.js')]: {
        importedIds: [],
        dynamicallyImportedIds: [],
      },
      [abs('ui/A.tsx')]: {
        importedIds: [abs('node_modules/react/index.js'), '\0commonjs-proxy'],
        dynamicallyImportedIds: [],
      },
    });
    expect(JSON.parse(emitted[0]!.source).modules).toEqual({ 'ui/A.tsx': [] });
  });

  it('writes nothing when the bundler cannot describe a module', () => {
    // A partial graph would narrow runs it cannot vouch for; none escalates.
    const { emitted, warnings } = generate({
      [abs('ui/A.tsx')]: { importedIds: [], dynamicallyImportedIds: [] },
      [abs('ui/B.tsx')]: null,
    });
    expect(emitted).toEqual([]);
    expect(warnings[0]).toMatch(/capture every story/);
  });

  it('never fails the build: an error warns and writes no graph', () => {
    const warnings: string[] = [];
    const plugin = juxtaposeModuleGraph({ root });
    expect(() =>
      plugin.generateBundle.call({
        getModuleIds: () => {
          throw new Error('boom');
        },
        getModuleInfo: () => null,
        emitFile: () => {
          throw new Error('unreachable');
        },
        warn: (m) => warnings.push(m),
      }),
    ).not.toThrow();
    expect(warnings[0]).toMatch(/boom.*capture every story/);
  });

  it('only runs in a build', () => {
    expect(juxtaposeModuleGraph().apply).toBe('build');
  });
});

describe('references the bundler graph does not show', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jux-scan-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, body = '') => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
    return path.join(dir, rel);
  };

  /** Runs the transform hook on a file with a resolver that finds nothing the
   *  filesystem does not, as Vite does for relative paths. */
  async function edgesOf(rel: string, body: string) {
    const id = put(rel, body);
    const plugin = juxtaposeModuleGraph({ root: dir });
    plugin.buildStart.call(undefined);
    await plugin.transform.call({ resolve: async () => null }, body, id);
    const emitted: { source: string }[] = [];
    plugin.generateBundle.call({
      getModuleIds: () => [id],
      getModuleInfo: () => ({ importedIds: [], dynamicallyImportedIds: [] }),
      emitFile: (f) => {
        emitted.push(f);
        return '';
      },
      warn: () => {},
    });
    return JSON.parse(emitted[0]!.source) as {
      modules: Record<string, string[]>;
      opaque: Record<string, string>;
      workers: boolean;
    };
  }

  it('follows a CSS @import and url()', async () => {
    put('ui/tokens.css', ':root{}');
    put('ui/logo.svg', '<svg/>');
    const g = await edgesOf(
      'ui/b.css',
      '@import "./tokens.css";\n.x{background:url(./logo.svg)} .y{background:url(data:image/png;base64,AA)}',
    );
    expect(g.modules['ui/b.css']).toEqual(['ui/logo.svg', 'ui/tokens.css']);
    expect(g.opaque).toEqual({});
  });

  it('follows Sass @use of a partial and CSS-modules composes', async () => {
    put('ui/_vars.scss', '$a: 1;');
    put('ui/base.module.css', '.a{}');
    const sass = await edgesOf('ui/c.scss', '@use "vars" as v;\n@use "sass:math";');
    expect(sass.modules['ui/c.scss']).toEqual(['ui/_vars.scss']);
    const mod = await edgesOf(
      'ui/d.module.css',
      '.b { composes: a from "./base.module.css"; }',
    );
    expect(mod.modules['ui/d.module.css']).toEqual(['ui/base.module.css']);
  });

  it('follows new URL(…, import.meta.url)', async () => {
    put('ui/data.txt', 'x');
    const g = await edgesOf(
      'ui/e.js',
      "export const u = new URL('./data.txt', import.meta.url);",
    );
    expect(g.modules['ui/e.js']).toEqual(['ui/data.txt']);
  });

  it('records what it cannot follow as opaque, never as nothing', async () => {
    const missing = await edgesOf('ui/f.css', '@import "./gone.css";');
    expect(Object.keys(missing.opaque)).toEqual(['ui/f.css']);
    const tailwind = await edgesOf('ui/g.css', '@import "tailwindcss";');
    expect(tailwind.opaque['ui/g.css']).toMatch(/tailwind/);
    const computed = await edgesOf(
      'ui/h.js',
      'new URL(`./${name}.png`, import.meta.url)',
    );
    expect(computed.opaque['ui/h.js']).toMatch(/computed/);
  });

  it('marks web workers, which a separate build bundles', async () => {
    const g = await edgesOf('ui/i.js', "import W from './w.js?worker'; new W();");
    expect(g.workers).toBe(true);
    expect(scanReferences('x.js', 'new Worker(url)').workers).toBe(true);
  });
});

describe('sourcePath', () => {
  it.each([
    ['\0virtual', null],
    ['virtual:foo', null],
    ['relative/path.ts', null],
    [abs('node_modules/x/i.js'), null],
    ['C:\\work\\app\\node_modules\\x\\i.js', null],
    ['C:/work/app/node_modules/x/i.js', null],
    [abs('a/b.ts?import'), 'a/b.ts'],
  ])('%s', (id, want) => {
    expect(sourcePath(id, root)).toBe(want);
  });
});
