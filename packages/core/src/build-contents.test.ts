// packages/core/src/build-contents.test.ts
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

// `files: ["dist"]` ships whatever tsc emits, and test fixtures that are .ts
// (browser/__fixtures__/spike-args.ts) were being emitted into the tarball.
// Asks tsc for its input list rather than reading dist, which keeps stale
// output from earlier builds.
it('the core build compiles no test fixtures or helpers', () => {
  const root = path.join(import.meta.dirname, '../../..');
  const out = execFileSync(
    path.join(root, 'node_modules/.bin/tsc'),
    ['-p', path.join(import.meta.dirname, '../tsconfig.json'), '--listFilesOnly'],
    { encoding: 'utf8' },
  );
  const ours = out
    .split('\n')
    .filter((f) => f.startsWith(import.meta.dirname.split(path.sep).join('/')));
  expect(ours.length).toBeGreaterThan(10);
  expect(ours.filter((f) => /\/(__fixtures__|__tests__)\/|\.test\.ts$/.test(f))).toEqual(
    [],
  );
}, 30_000);
