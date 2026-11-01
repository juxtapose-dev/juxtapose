import { expect, test } from 'vitest';
import { transform } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { juxtaposeComponentEvidence } from './component-plugin.js';
const configPlugin = () =>
  juxtaposeComponentEvidence().find((entry) => 'config' in entry)!;

test('enables production Vue hooks without overriding an explicit opt-out', () => {
  const plugin = configPlugin();
  expect(plugin.config?.({})).toMatchObject({
    define: { __VUE_PROD_DEVTOOLS__: 'true' },
  });
  expect(plugin.config?.({ define: { __VUE_PROD_DEVTOOLS__: 'false' } })).toMatchObject({
    define: { __VUE_PROD_DEVTOOLS__: 'false' },
  });
});
test('preserves names for esbuild minification while honoring explicit opt-outs', () => {
  const plugin = configPlugin();
  expect(plugin.config?.({})).toMatchObject({ esbuild: { keepNames: true } });
  expect(plugin.config?.({ esbuild: { keepNames: false } })).toMatchObject({
    esbuild: { keepNames: false },
  });
  expect(plugin.config?.({ esbuild: false })).toMatchObject({ esbuild: false });
});
test('keeps authored React function and arrow-component names through actual production minification', async () => {
  const config = configPlugin().config?.({});
  const code =
    'function SettingsPanel(){return "panel"}const SaveButton=()=>"button";globalThis.names=[SettingsPanel.name,SaveButton.name];';
  const compile = async (keepNames: boolean) => {
    const built = await transform(code, { minify: true, format: 'iife', keepNames });
    const result: unknown = runInNewContext(built.code + ';globalThis.names');
    return result;
  };
  expect(await compile(false)).not.toEqual(['SettingsPanel', 'SaveButton']);
  expect(
    await compile(config?.esbuild !== false && config?.esbuild?.keepNames === true),
  ).toEqual(['SettingsPanel', 'SaveButton']);
});
