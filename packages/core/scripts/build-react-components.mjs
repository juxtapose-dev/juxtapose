import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const core = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const bippy = dirname(require.resolve('bippy/package.json'));
const metadata = JSON.parse(await readFile(join(bippy, 'package.json'), 'utf8'));
if (metadata.version !== '0.7.3' || metadata.license !== 'MIT')
  throw new Error('Unexpected React provider dependency');
const notice = await readFile(join(bippy, 'LICENSE'), 'utf8');
const react = createRequire(join(bippy, 'package.json')).resolve('react');
const output = join(core, 'dist/components/react-browser.bundle.js');
const result = await build({
  absWorkingDir: core,
  entryPoints: ['src/components/react-browser.ts'],
  outfile: output,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: '__juxReactComponents',
  minify: true,
  treeShaking: true,
  sourcemap: false,
  metafile: true,
  write: false,
  legalComments: 'inline',
  banner: {
    js: `/* juxtapose.react-browser/v1\nBundled bippy0.7.3 (MIT):\n${notice.replaceAll('*/', '* /')}\n*/`,
  },
  // The unused useFiber helper reads React at module initialization. Its peer import
  // has no role in this provider; remove that read and its otherwise side-effectful CJS import.
  pure: ['Reflect.get'],
  plugins: [
    {
      name: 'omit-unused-react-helper',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: react, sideEffects: false }));
      },
    },
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
});
const asset = result.outputFiles.find((f) => f.path === output);
if (!asset || asset.contents.length > 128 * 1024)
  throw new Error('React browser asset exceeds its bound');
for (const value of Object.values(result.metafile.outputs))
  for (const [name, info] of Object.entries(value.inputs)) {
    if (/(?:^|\/)react(?:-dom)?\//.test(name) && info.bytesInOutput > 0)
      throw new Error('React runtime must not be bundled into the component provider');
  }
if (Object.values(result.metafile.outputs).some((value) => value.imports.length > 0))
  throw new Error('React browser asset must be self-contained');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, asset.contents);
await writeFile(
  join(dirname(output), 'react-browser-NOTICE.txt'),
  `bippy0.7.3\n${notice}`,
);
const report = {
  schema: 'juxtapose.react-browser-build/v1',
  bippy: '0.7.3',
  bytes: asset.contents.length,
  sha256: createHash('sha256').update(asset.contents).digest('hex'),
  reactRuntimeBytes: 0,
};
await writeFile(
  join(dirname(output), 'react-browser-build.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report));
