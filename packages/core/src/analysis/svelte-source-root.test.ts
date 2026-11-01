import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { svelteComponentInstrumentation } from './svelte-components.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(repository = true, subdirectory = 'apps/dashboard') {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-source-root-'));
  roots.push(root);
  if (repository) execFileSync('git', ['init', '--quiet', root]);
  const project = path.join(root, subdirectory);
  mkdirSync(path.join(project, 'node_modules/svelte'), { recursive: true });
  writeFileSync(path.join(project, 'package.json'), '{}');
  // Only this package has a compiler: root discovery must not change lookup.
  writeFileSync(
    path.join(project, 'node_modules/svelte/package.json'),
    '{"exports":{"./compiler":"./compiler.cjs"}}',
  );
  writeFileSync(
    path.join(project, 'node_modules/svelte/compiler.cjs'),
    'exports.VERSION="5.55.7";exports.parse=()=>({instance:null,fragment:{nodes:[]}});',
  );
  const file = (relative: string) => {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, '<p>hello</p>');
    return filename;
  };
  const plugin = svelteComponentInstrumentation(project);
  plugin.buildStart();
  return { root, project, file, plugin };
}

test('package-local compiler emits repository-relative monorepo component sources', () => {
  const { plugin, file } = fixture();
  const result = plugin.transform('<p>hello</p>', file('apps/dashboard/src/Card.svelte'));
  expect(result?.code).toContain(
    'registry.register("Card","apps/dashboard/src/Card.svelte"',
  );
});

test('single-package repositories keep their existing source coordinate', () => {
  const { plugin, file } = fixture(true, '.');
  expect(plugin.transform('<p>hello</p>', file('src/Card.svelte'))?.code).toContain(
    'registry.register("Card","src/Card.svelte"',
  );
});

test('workspace components outside the project still use their repository path', () => {
  const { plugin, file } = fixture();
  expect(
    plugin.transform('<p>hello</p>', file('packages/ui/Card.svelte'))?.code,
  ).toContain('registry.register("Card","packages/ui/Card.svelte"');
});

test('missing repository identity omits source without disabling instrumentation', () => {
  const { plugin, file } = fixture(false);
  expect(
    plugin.transform('<p>hello</p>', file('apps/dashboard/src/Card.svelte'))?.code,
  ).toContain('registry.register("Card",null');
});

test('symlinked external sources cannot acquire a false repository coordinate', () => {
  const { root, plugin } = fixture();
  const outside = fixture(false, '.');
  const external = outside.file('Card.svelte');
  const filename = path.join(root, 'apps/dashboard/Card.svelte');
  symlinkSync(external, filename);
  expect(plugin.transform('<p>hello</p>', filename)?.code).toContain(
    'registry.register("Card",null',
  );
});
