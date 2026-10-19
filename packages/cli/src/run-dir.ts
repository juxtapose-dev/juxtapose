import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Most recent saved report, unaffected by later analysis/cache writes. */
export async function latestRunDir(projectRoot: string): Promise<string | null> {
  const runsRoot = path.join(projectRoot, '.juxtapose', 'runs');
  if (!existsSync(runsRoot)) return null;

  let newest: { dir: string; mtime: number } | null = null;
  for (const entry of await readdir(runsRoot)) {
    const dir = path.join(runsRoot, entry);
    const report = path.join(dir, 'report.json');
    if (!existsSync(report)) continue;
    const { mtimeMs } = await stat(report);
    if (
      !newest ||
      mtimeMs > newest.mtime ||
      (mtimeMs === newest.mtime && dir > newest.dir)
    )
      newest = { dir, mtime: mtimeMs };
  }
  return newest?.dir ?? null;
}
