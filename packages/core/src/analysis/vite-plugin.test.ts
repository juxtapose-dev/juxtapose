import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { juxtaposeModuleGraph, sourcePath } from './vite-plugin.js';
import { MODULE_GRAPH_FILE } from './module-graph.js';

const root = path.resolve('/work/app');
const abs = (p: string) => path.join(root, p);

interface Info {
  importedIds: string[];
  dynamicallyImportedIds: string[];
}

/** Drives the hook with a fake Rollup context; a real build is checked on
 *  the examples. */
function generate(modules: Record<string, Info | null>) {
  const emitted: { fileName: string; source: string }[] = [];
  const warnings: string[] = [];
  const plugin = juxtaposeModuleGraph({ root });
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
    expect(JSON.parse(emitted[0]!.source)).toEqual({
      version: 1,
      modules: {
        'stories/A.stories.tsx': ['../other/pkg.ts', 'ui/A.tsx', 'ui/Lazy.tsx'],
        'ui/A.tsx': ['ui/a.css'],
      },
    });
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

  it('only runs in a build', () => {
    expect(juxtaposeModuleGraph().apply).toBe('build');
  });
});

describe('sourcePath', () => {
  it.each([
    ['\0virtual', null],
    ['virtual:foo', null],
    ['relative/path.ts', null],
    [abs('node_modules/x/i.js'), null],
    [abs('a/b.ts?import'), 'a/b.ts'],
  ])('%s', (id, want) => {
    expect(sourcePath(id, root)).toBe(want);
  });
});
