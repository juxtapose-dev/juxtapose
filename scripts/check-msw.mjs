// Exercise the built addon/adapter and real MSW worker, not a mocked fetch API.
// Run after pnpm build && pnpm --filter example-storybook build.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeStructure, encodeStoryId } from '../packages/core/dist/index.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const project = await mkdtemp(path.join(tmpdir(), 'jux-msw-'));
const expected = new Map([
  ['msw--alice', 'Mocked Alice'],
  ['msw--bob', 'Mocked Bob'],
]);

try {
  await cp(
    path.join(root, 'examples/storybook/storybook-static'),
    path.join(project, 'storybook-static'),
    { recursive: true },
  );
  await writeFile(
    path.join(project, 'juxtapose.config.json'),
    JSON.stringify({
      platform: 'storybook',
      buildDir: 'storybook-static',
      viewport: { width: 800, height: 600 },
      concurrency: 2,
    }),
  );
  let previous;
  for (let iteration = 0; iteration < 3; iteration++) {
    const result = await exec(
      process.execPath,
      [path.join(root, 'packages/cli/dist/index.js'), 'run', 'msw--*', '--json'],
      {
        cwd: project,
        env: { ...process.env, JUX_NO_DAEMON: '1' },
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).catch((error) => {
      // New, deliberately unapproved captures need review (exit 1).
      if (error.code === 1 && error.stdout) return error;
      throw error;
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.capturedCount, expected.size);
    assert.equal(report.results.length, expected.size);
    const hashes = {};
    for (const capture of report.results) {
      const label = expected.get(capture.storyId);
      assert.ok(label, `Unexpected capture: ${capture.storyId}`);
      assert.equal(capture.status, 'new');
      assert.equal(capture.error, undefined);
      const structure = decodeStructure(
        await readFile(
          path.join(
            project,
            '.juxtapose/runs',
            report.runId,
            'images',
            `${encodeStoryId(capture.storyId)}-current.structure.json.gz`,
          ),
        ),
      );
      assert.ok(
        structure.elements.some((element) => element.text === label),
        `${capture.storyId}: mocked response was not rendered`,
      );
      assert.match(capture.hash, /^[a-f0-9]{64}$/);
      hashes[capture.storyId] = capture.hash;
    }
    assert.notEqual(hashes['msw--alice'], hashes['msw--bob']);
    if (previous) assert.deepEqual(hashes, previous);
    previous = hashes;
  }
  console.log(
    'PASS real MSW: two mocked stories captured correctly and byte-stable across three runs',
  );
} finally {
  await rm(project, { recursive: true, force: true });
}
