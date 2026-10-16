#!/usr/bin/env node
// Prepare an isolated fixture; dependency installation belongs to CI, never here.
// node scripts/check-discovery-selection.mjs --prepare VERSION FIXTURE
// node scripts/check-discovery-selection.mjs FIXTURE EVIDENCE
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
if (process.argv[2] === '--prepare') {
  const version = process.argv[3],
    fixture = path.resolve(process.argv[4]);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  mkdirSync(path.join(fixture, '.storybook'), { recursive: true });
  mkdirSync(path.join(fixture, 'stories'), { recursive: true });
  const files = {
    'package.json': JSON.stringify({
      name: 'jux-discovery-compatibility',
      private: true,
      type: 'module',
      devDependencies: {
        storybook: version,
        '@storybook/react-vite': version,
        react: '18.3.1',
        'react-dom': '18.3.1',
        vite: '6.3.5',
      },
    }),
    '.gitignore': 'node_modules\nstatic/\n.juxtapose/\n',
    '.storybook/main.js': `import {juxtaposeModuleGraph} from ${JSON.stringify(pathToFileURL(path.join(root, 'packages/core/dist/analysis/vite-plugin.js')).href)};\nexport default {stories:['../stories/**/*.stories.jsx'],framework:{name:'@storybook/react-vite',options:{}},addons:[],viteFinal:async config=>({...config,plugins:[...config.plugins,juxtaposeModuleGraph()]})};\n`,
    '.storybook/preview.js':
      'export default {parameters:{juxtapose:{viewport:{width:800,height:600}}}};\n',
    'stories/A.jsx':
      "import React from 'react';export const A=()=> <button>Alpha</button>;\n",
    'stories/A.stories.jsx':
      "import {A} from './A';export default {title:'A',component:A};export const Default={parameters:{juxtapose:{variants:{mobile:{viewport:{width:390,height:844}}}}}};\n",
    'stories/B.stories.jsx':
      "import React from 'react';export default {title:'B',component:()=> <p>Beta</p>};export const Default={};\n",
    'juxtapose.config.json': JSON.stringify({
      platform: 'storybook',
      buildDir: 'static',
      concurrency: 3,
      recheck: 'off',
      variants: { dark: { colorScheme: 'dark' } },
    }),
  };
  for (const [name, contents] of Object.entries(files))
    writeFileSync(path.join(fixture, name), contents);
  console.log(fixture);
} else {
  const fixture = path.resolve(process.argv[2]),
    out = path.resolve(process.argv[3]);
  mkdirSync(out, { recursive: true });
  const expectedVersion = JSON.parse(readFileSync(path.join(fixture, 'package.json')))
    .devDependencies.storybook;
  const installedVersion = JSON.parse(
    readFileSync(path.join(fixture, 'node_modules/storybook/package.json')),
  ).version;
  assert.equal(installedVersion, expectedVersion);
  const evidence = { version: installedVersion, discovery: [], cli: [], checks: [] };
  const save = () =>
    writeFileSync(
      path.join(out, 'summary.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init');
  git(
    'add',
    '.gitignore',
    'package.json',
    'package-lock.json',
    '.storybook',
    'stories',
    'juxtapose.config.json',
  );
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'discovery fixture',
  );
  const { Browser, resolveChrome } =
    await import('../packages/core/dist/browser/index.js');
  const { prepareCaptures } = await import('../packages/core/dist/index.js');
  const { StorybookPlatform } =
    await import('../packages/adapter-storybook/dist/index.js');
  const { serveStatic } = await import('../packages/cli/dist/serve-static.js');
  const build = path.join(fixture, 'static');
  const project = JSON.parse(readFileSync(path.join(build, 'project.json')));
  assert.equal(project.storybookVersion, expectedVersion);
  const server = await serveStatic(build);
  const browser = await Browser.launch({ executablePath: resolveChrome().path });
  const platform = new StorybookPlatform();
  try {
    for (const ids of [['a--default'], undefined]) {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      try {
        const page = await context.newPage(),
          requests = [];
        page.on('Network.requestWillBeSent', (p) => requests.push(p.request.url));
        await page.send('Network.enable');
        const found = await platform.discoverParams(page, server.url, ids);
        const params = Object.fromEntries(found);
        assert.deepEqual(params['a--default'], {
          viewport: { width: 800, height: 600 },
          variants: { mobile: { viewport: { width: 390, height: 844 } } },
        });
        const csfs = [
          ...new Set(
            requests
              .filter((u) => /\/[AB]\.stories-/.test(u))
              .map((u) => new URL(u).pathname),
          ),
        ].sort();
        assert.ok(
          csfs.some((u) => u.includes('/A.stories-')),
          'A CSF requested',
        );
        assert.equal(
          csfs.some((u) => u.includes('/B.stories-')),
          ids === undefined,
          'unrelated B CSF loaded only for full discovery',
        );
        if (ids) assert.deepEqual(Object.keys(params), ['a--default']);
        else
          assert.deepEqual(params['b--default'], {
            viewport: { width: 800, height: 600 },
          });
        evidence.discovery.push({ kind: ids ? 'subset' : 'full', params, csfs });
        save();
      } finally {
        await context.close();
      }
    }
    // Exercise actual cache boundaries with real preview loads, not fake APIs.
    const stories = await platform.enumerate({ projectRoot: fixture, buildDir: build });
    const cacheDir = path.join(out, 'cache');
    mkdirSync(cacheDir);
    const original = platform.discoverParams.bind(platform);
    let liveCalls = 0;
    platform.discoverParams = async (...args) => {
      liveCalls++;
      return original(...args);
    };
    const options = {
      platform,
      browser,
      baseUrl: server.url,
      viewport: { width: 800, height: 600 },
      cache: { dir: cacheDir, target: { projectRoot: fixture, buildDir: build } },
    };
    const subset = await prepareCaptures(stories, {
      ...options,
      storyIds: ['a--default'],
    });
    assert.ok(subset.some((s) => s.storyId === 'a--default__mobile'));
    await prepareCaptures(stories, { ...options, storyIds: ['a--default'] });
    assert.equal(liveCalls, 1);
    const full = await prepareCaptures(stories, options);
    assert.equal(liveCalls, 2);
    assert.deepEqual(full.find((s) => s.storyId === 'b--default').params.viewport, {
      width: 800,
      height: 600,
    });
    await prepareCaptures(stories, options);
    assert.equal(liveCalls, 2);
    evidence.checks.push('subset cache hit; subset cannot satisfy full; full cache hit');
    save();
    // Real preview extraction fallback after deliberately hiding optional APIs.
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    try {
      const page = await context.newPage();
      const fallbackPage = {
        goto: async (url) => {
          await page.goto(url);
          await page.evaluate(async () => {
            for (
              let i = 0;
              i < 200 && !globalThis.__STORYBOOK_PREVIEW__?.storyStoreValue;
              i++
            )
              await new Promise((r) => setTimeout(r, 25));
            const p = globalThis.__STORYBOOK_PREVIEW__;
            p.loadStory = undefined;
            p.storyStoreValue.loadStory = undefined;
          });
        },
        evaluate: page.evaluate.bind(page),
      };
      const found = await original(fallbackPage, server.url, ['a--default']);
      assert.deepEqual(
        found.get('a--default'),
        evidence.discovery[0].params['a--default'],
      );
      assert.deepEqual(found.get('b--default'), {
        viewport: { width: 800, height: 600 },
      });
      evidence.checks.push(
        'actual whole-store fallback works with optional per-story APIs hidden',
      );
      save();
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  const all = [
    'a--default',
    'a--default__dark',
    'a--default__mobile',
    'b--default',
    'b--default__dark',
  ];
  const run = (name, flags, ids, reason) => {
    const runs = path.join(fixture, '.juxtapose/runs');
    let before = [];
    try {
      before = readdirSync(runs);
    } catch {}
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'packages/cli/dist/index.js'), 'run', '--no-daemon', ...flags],
      {
        cwd: fixture,
        env: { ...process.env, JUX_NO_DAEMON: '1' },
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    writeFileSync(
      path.join(out, name + '.log'),
      (result.stdout ?? '') + (result.stderr ?? ''),
    );
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.equal(result.status, ids.length ? 1 : 0);
    assert.ok((result.stdout + result.stderr).includes(`(${reason}`));
    const added = readdirSync(runs).filter(
      (x) => !before.includes(x) && existsSync(path.join(runs, x, 'report.json')),
    );
    assert.equal(added.length, ids.length ? 1 : 0);
    let report;
    if (ids.length) {
      report = JSON.parse(readFileSync(path.join(runs, added[0], 'report.json')));
      assert.deepEqual(report.results.map((r) => r.storyId).sort(), [...ids].sort());
      assert.ok(report.results.every((r) => r.status === 'new' && !r.error));
      writeFileSync(path.join(out, name + '.json'), JSON.stringify(report, null, 2));
    }
    evidence.cli.push({
      name,
      ids,
      reason,
      status: result.status,
      summary: report?.summary,
    });
    save();
  };
  run('full', ['--all'], all, 'no-baseline');
  run('unchanged', ['--since', 'HEAD'], [], 'no-changes');
  const component = path.join(fixture, 'stories/A.jsx');
  writeFileSync(component, readFileSync(component, 'utf8') + '// comment-only change\n');
  // Storybook 9 and 10 expose different bin paths; use package metadata.
  const sbPackage = JSON.parse(
    readFileSync(path.join(fixture, 'node_modules/storybook/package.json')),
  );
  const bin =
    typeof sbPackage.bin === 'string' ? sbPackage.bin : Object.values(sbPackage.bin)[0];
  const built = spawnSync(
    process.execPath,
    [
      path.join(fixture, 'node_modules/storybook', bin),
      'build',
      '--disable-telemetry',
      '-o',
      'static',
    ],
    { cwd: fixture, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(out, 'rebuild.log'),
    (built.stdout ?? '') + (built.stderr ?? ''),
  );
  assert.equal(built.status, 0);
  run(
    'component',
    ['--since', 'HEAD'],
    ['a--default', 'a--default__dark', 'a--default__mobile'],
    'graph-walk',
  );
  run('full-after-subset', ['--all'], all, 'no-baseline');
  run('variant', ['--story', 'a--default__mobile'], ['a--default__mobile'], 'requested');
  writeFileSync(component, readFileSync(component, 'utf8') + '// stale graph\n');
  run('stale', ['--since', 'HEAD'], all, 'stale-graph');
  writeFileSync(path.join(fixture, 'unknown.js'), 'export const unknown=1;\n');
  // Stale takes precedence; restore the last built component to test unmapped.
  writeFileSync(
    component,
    readFileSync(component, 'utf8').replace('// stale graph\n', ''),
  );
  run('unmapped', ['--since', 'HEAD'], all, 'unmapped-change');
  const config = path.join(fixture, 'juxtapose.config.json');
  const cfg = JSON.parse(readFileSync(config));
  cfg.viewport = { width: 800, height: 600 };
  writeFileSync(config, JSON.stringify(cfg));
  run('config', ['--since', 'HEAD'], all, 'config-changed');
  evidence.passed = true;
  save();
  console.log(
    `Storybook ${installedVersion}: discovery, inheritance, cache, fallback and ${evidence.cli.length} real CLI checks passed. Evidence: ${out}`,
  );
}
