import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { viteFinal } from './preset.js';

test('a bad storage.dir warns and disables capture instead of throwing at startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-preset-'));
  await writeFile(
    path.join(root, 'juxtapose.config.json'),
    JSON.stringify({ storage: { kind: 'cache', dir: '../escape' } }),
  );
  vi.stubEnv('JUXTAPOSE_ROOT', root);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const out = viteFinal({ plugins: [] });
    // Capture is off, but the build still records the module graph.
    expect(out.plugins?.map((pl) => (pl as { name: string }).name)).toEqual([
      'juxtapose',
      'juxtapose:module-graph',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture disabled'));
  } finally {
    warn.mockRestore();
    vi.unstubAllEnvs();
  }
});
