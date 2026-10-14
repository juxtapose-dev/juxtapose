import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isForeignVirtual, juxtaposeModuleGraph, sourcePath } from './vite-plugin.js';
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
      version: 3,
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

  it('records files the build read that no module accounts for', () => {
    const emitted: { source: string }[] = [];
    const plugin = juxtaposeModuleGraph({ root });
    plugin.buildStart.call(undefined);
    plugin.generateBundle.call({
      getModuleIds: () => [abs('ui/A.tsx'), '\0virtual:tokens'],
      getModuleInfo: () => ({ importedIds: [], dynamicallyImportedIds: [] }),
      getWatchFiles: () => [
        abs('ui/A.tsx'),
        abs('src/tokens.js'),
        abs('node_modules/x/i.js'),
      ],
      emitFile: (f) => {
        emitted.push(f);
        return '';
      },
      warn: () => {},
    });
    const g = JSON.parse(emitted[0]!.source);
    expect(g.external).toEqual(['src/tokens.js']);
    // …and a virtual module a user plugin made is opaque.
    expect(Object.keys(g.opaque)).toEqual(['virtual:virtual:tokens']);
  });

  it.each([
    ['\0vite/preload-helper', false],
    ['\0commonjs-proxy', false],
    ['/virtual:/@storybook/builder-vite/vite-app.js', false],
    ['virtual:generated-list', false],
    ['\0virtual:svg-icons', true],
    ['\0my-plugin:tokens', true],
  ])('virtual module %s from a build plugin is opaque: %s', (id, foreign) => {
    expect(isForeignVirtual(id)).toBe(foreign);
  });

  it('records build.cssCodeSplit', () => {
    const emitted: { source: string }[] = [];
    const plugin = juxtaposeModuleGraph({ root });
    plugin.configResolved({ build: { cssCodeSplit: false } });
    plugin.buildStart.call(undefined);
    plugin.generateBundle.call({
      getModuleIds: () => [],
      getModuleInfo: () => null,
      emitFile: (f) => {
        emitted.push(f);
        return '';
      },
      warn: () => {},
    });
    expect(JSON.parse(emitted[0]!.source).cssCodeSplit).toBe(false);
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
      hashes: Record<string, string>;
    };
  }

  it('does not parse stylesheets: their edges are not recorded, a change to one is never narrowed', async () => {
    put('ui/tokens.css', ':root{}');
    const g = await edgesOf(
      'ui/b.css',
      '@import "./tokens.css"; .x{background:url(./logo.svg)}',
    );
    expect(g.modules['ui/b.css']).toEqual([]);
    expect(g.opaque).toEqual({});
  });

  it('records a sha256 of each source as the build read it', async () => {
    const g = await edgesOf('ui/j.js', 'export const j = 1;');
    expect(g.hashes['ui/j.js']).toBe(
      createHash('sha256').update('export const j = 1;').digest('hex'),
    );
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
    const missing = await edgesOf('ui/f.js', "new URL('./gone.png', import.meta.url)");
    expect(missing.opaque['ui/f.js']).toMatch(/unresolved/);
    const computed = await edgesOf(
      'ui/h.js',
      'new URL(`./${name}.png`, import.meta.url)',
    );
    expect(computed.opaque['ui/h.js']).toMatch(/computed/);
  });

  it.each([
    "import W from './w.js?worker'",
    "import W from './w.js?sharedworker'",
    'new Worker(url)',
    'new SharedWorker(url)',
    "CSS.paintWorklet.addModule('/p.js')",
    "audioContext.audioWorklet.addModule('/a.js')",
    "navigator.serviceWorker.register('/sw.js')",
  ])('marks %s as a worker or worklet, which a separate build bundles', async (code) => {
    const g = await edgesOf('ui/i.js', code);
    expect(g.workers).toBe(true);
    expect(g.opaque['ui/i.js']).toMatch(/worker or worklet/);
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
