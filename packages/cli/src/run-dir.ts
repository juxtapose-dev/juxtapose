import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Most recent run directory containing a report, or null. */
export async function latestRunDir(projectRoot: string): Promise<string | null> {
  const runsRoot = path.join(projectRoot, '.juxtapose', 'runs');
  if (!existsSync(runsRoot)) return null;

  let newest: { dir: string; mtime: number } | null = null;
  for (const entry of await readdir(runsRoot)) {
    const dir = path.join(runsRoot, entry);
    if (!existsSync(path.join(dir, 'report.json'))) continue;
    const { mtimeMs } = await stat(dir);
    if (!newest || mtimeMs > newest.mtime) newest = { dir, mtime: mtimeMs };
  }
  return newest?.dir ?? null;
}
