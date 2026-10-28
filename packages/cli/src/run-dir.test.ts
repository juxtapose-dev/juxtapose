import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { latestRunDir } from './run-dir.js';

test('analysis in an older run cannot change the latest saved report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-latest-'));
  try {
    for (const [id, date] of [
      ['r1', '2000-01-01'],
      ['r2', '2000-01-02'],
    ]) {
      const dir = path.join(root, '.juxtapose/runs', id!);
      await mkdir(dir, { recursive: true });
      const report = path.join(dir, 'report.json');
      await writeFile(report, '{}');
      await utimes(report, new Date(date!), new Date(date!));
    }
    const older = path.join(root, '.juxtapose/runs/r1');
    const newer = path.join(root, '.juxtapose/runs/r2');
    await mkdir(path.join(older, 'reference-analysis-v1'));
    await utimes(older, new Date('2030-01-01'), new Date('2030-01-01'));
    expect(await latestRunDir(root)).toBe(newer);
    // Equal report timestamps resolve deterministically, not by directory iteration order.
    await utimes(
      path.join(older, 'report.json'),
      new Date('2000-01-02'),
      new Date('2000-01-02'),
    );
    expect(await latestRunDir(root)).toBe(newer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
