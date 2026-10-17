import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { latestRunDir } from './run-dir.js';

test('historical analysis does not change which capture is latest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-report-order-'));
  try {
    const runs = path.join(root, '.juxtapose/runs');
    for (const [id, time] of [
      ['r1', '2020-01-01'],
      ['r2', '2020-01-02'],
    ]) {
      const dir = path.join(runs, id!);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'report.json'), '{}');
      await utimes(path.join(dir, 'report.json'), new Date(time!), new Date(time!));
    }
    await mkdir(path.join(runs, 'r1/reference-analysis-v1'));
    await utimes(path.join(runs, 'r1'), new Date('2030-01-01'), new Date('2030-01-01'));
    expect(await latestRunDir(root)).toBe(path.join(runs, 'r2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
