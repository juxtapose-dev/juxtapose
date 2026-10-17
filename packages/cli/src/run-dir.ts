import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Most recent report, or null. Derived analysis may be added to old runs. */
export async function latestRunDir(projectRoot: string): Promise<string | null> {
  const runsRoot = path.join(projectRoot, '.juxtapose', 'runs');
  if (!existsSync(runsRoot)) return null;

  let newest: { dir: string; mtime: number } | null = null;
  for (const entry of await readdir(runsRoot)) {
    const dir = path.join(runsRoot, entry);
    if (!existsSync(path.join(dir, 'report.json'))) continue;
    // Creating reference-analysis-v1 in a historical run changes its directory
    // mtime after a newer capture. Only the immutable report orders captures.
    const { mtimeMs } = await stat(path.join(dir, 'report.json'));
    if (!newest || mtimeMs > newest.mtime) newest = { dir, mtime: mtimeMs };
  }
  return newest?.dir ?? null;
}
