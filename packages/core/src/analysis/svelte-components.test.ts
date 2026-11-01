import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SourceMap } from 'node:module';
import {
  instrumentSvelteComponent,
  loadSvelteComponentCompiler,
  svelteComponentInstrumentation,
} from './svelte-components.js';
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'jux-svelte-transform-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function file(relative: string): string {
  const filename = path.join(root, relative);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, '');
  return filename;
}
const compiler = (ast: unknown) => ({ VERSION: '5.55.7', parse: () => ast });
it('injects lifecycle and actions with collision-free bindings, without wrappers or attributes', () => {
  const source = '<script>const __jux_svelte_0=1;</script><p>one</p><span>two</span>';
  const result = instrumentSvelteComponent(
    source,
    file('src/Fragment.svelte'),
    root,
    compiler({
      instance: { content: { start: 8 } },
      fragment: {
        nodes: [
          { type: 'RegularElement', start: source.indexOf('<p>') },
          { type: 'RegularElement', start: source.indexOf('<span>') },
        ],
      },
    }),
  );
  expect(result?.code).toContain('getContext as __jux_svelte_1get');
  expect(result?.code).toContain('onDestroy');
  expect(result?.code).toContain('registry.register("Fragment","src/Fragment.svelte"');
  expect(result?.code).toContain('<p use:__jux_svelte_1action>');
  expect(result?.code).toContain('<span use:__jux_svelte_1action>');
  expect(result?.code).not.toContain('data-');
  expect(result?.code).not.toContain('/project');
  expect(result?.map.sourcesContent).toBeUndefined();
});
it('registers empty/text-only components without fabricating DOM associations', () => {
  const result = instrumentSvelteComponent(
    'text only',
    file('Text.svelte'),
    root,
    compiler({ fragment: { nodes: [{ type: 'Text', start: 0 }] } }),
  );
  expect(result?.code).toMatch(/^<script>.*registry.register/);
  expect(result?.code).toMatch(/<\/script>text only$/);
  expect(result?.code).not.toContain(' use:');
});
it('omits unverifiable source, refuses non-component/SSR transforms and needs no Svelte dependency', () => {
  expect(
    instrumentSvelteComponent(
      '',
      '/outside/Empty.svelte',
      root,
      compiler({ instance: null, fragment: { nodes: [] } }),
    )?.code,
  ).toContain('registry.register("Empty",null');
  expect(
    instrumentSvelteComponent('', '/project/file.svelte?type=style', root, compiler({})),
  ).toBeNull();
  expect(loadSvelteComponentCompiler('/path/without/svelte')).toBeNull();
  expect(
    svelteComponentInstrumentation('/path/without/svelte').transform('', 'App.svelte', {
      ssr: true,
    }),
  ).toBeNull();
});
it('fails explicitly on unsupported parser shapes', () => {
  expect(() =>
    instrumentSvelteComponent('x', '/project/A.svelte', root, compiler({})),
  ).toThrow('Unsupported Svelte component AST');
});

it('preserves authored statement and markup locations in a high-resolution source map', () => {
  const source = '<script>\nconst answer = 42;\n</script>\n<p>{answer}</p>';
  const filename = file('Answer.svelte');
  const result = instrumentSvelteComponent(
    source,
    filename,
    root,
    compiler({
      instance: { content: { start: 8 } },
      fragment: { nodes: [{ type: 'RegularElement', start: source.indexOf('<p>') }] },
    }),
  );
  if (!result) throw new Error('Expected transformed component.');
  const { map } = result;
  const consumer = new SourceMap({
    file: filename,
    version: map.version,
    sources: map.sources,
    names: map.names,
    mappings: map.mappings,
    sourcesContent: [],
    sourceRoot: '',
  });
  for (const text of ['const answer', '<p', '{answer}']) {
    const originalIndex = source.indexOf(text);
    const generatedIndex = result.code.indexOf(text);
    const originalLines = source.slice(0, originalIndex).split('\n');
    const generatedLines = result.code.slice(0, generatedIndex).split('\n');
    expect(
      consumer.findEntry(generatedLines.length - 1, generatedLines.at(-1)?.length ?? 0),
    ).toMatchObject({
      originalSource: filename,
      originalLine: originalLines.length - 1,
      originalColumn: originalLines.at(-1)?.length ?? 0,
    });
  }
  expect(map.sourcesContent).toBeUndefined();
});
it('omits source identity containing URL delimiters', () => {
  for (const name of ['name%20', 'name#fragment']) {
    expect(
      instrumentSvelteComponent(
        '',
        file(`${name}.svelte`),
        root,
        compiler({ fragment: { nodes: [] } }),
      )?.code,
    ).toContain(`registry.register("${name}",null`);
  }
});
