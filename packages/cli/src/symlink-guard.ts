// A hostile clone can commit `.juxtapose` (or `.juxtapose/crops`, `snaps`) as
// a symlink; `rm -r` and writes would then follow it out of the project. The
// commands that clear or write scratch dirs check first and refuse.

import { lstat } from 'node:fs/promises';
import path from 'node:path';

/** The first symlink on the way from `root` down `segments`, or undefined.
 *  `root` itself is trusted (macOS /tmp is a symlink); a segment that does not
 *  exist ends the walk, since nothing below it can be a link. */
export async function firstSymlink(
  root: string,
  segments: string[],
): Promise<string | undefined> {
  let cur = root;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    try {
      if ((await lstat(cur)).isSymbolicLink()) return cur;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function symlinkRefusal(link: string): string {
  return `jux: refusing to write through symlink ${link}; remove it or point --project elsewhere.\n`;
}
