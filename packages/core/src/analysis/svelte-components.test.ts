import { expect, it } from 'vitest';
import {
  instrumentSvelteComponent,
  loadSvelteComponentCompiler,
  svelteComponentInstrumentation,
} from './svelte-components.js';
const root = '/project';
const compiler = (ast: unknown) => ({ VERSION: '5.55.7', parse: () => ast });
it('injects lifecycle and actions with collision-free bindings, without wrappers or attributes', () => {
  const source = '<script>const __jux_svelte_0=1;</script><p>one</p><span>two</span>';
  const result = instrumentSvelteComponent(
    source,
    '/project/src/Fragment.svelte',
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
  expect(result?.map).toBeNull();
});
it('registers empty/text-only components without fabricating DOM associations', () => {
  const result = instrumentSvelteComponent(
    'text only',
    '/project/Text.svelte',
    root,
    compiler({ fragment: { nodes: [{ type: 'Text', start: 0 }] } }),
  );
  expect(result?.code).toMatch(/^<script>.*registry.register/);
  expect(result?.code).toMatch(/<\/script>text only$/);
  expect(result?.code).not.toContain(' use:');
});
it('omits source outside the project, refuses non-component/SSR transforms and needs no Svelte dependency', () => {
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
