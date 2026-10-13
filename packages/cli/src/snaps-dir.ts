import path from 'node:path';

/** Where `jux snap` writes and `jux diff` reads. */
export function snapsDir(project?: string): string {
  return path.join(path.resolve(project ?? process.cwd()), '.juxtapose', 'snaps');
}
