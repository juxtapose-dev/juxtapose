// A directory only this user can write, verified rather than assumed. Shared
// by the Chrome profile root (launch.ts) and the daemon state dir
// (daemon/state.ts): both hold things another local user must not be able to
// plant, swap or read through (Ruling 17).

import { lstat, mkdir } from 'node:fs/promises';

/**
 * Creates `dir` 0700 if missing, then checks it with lstat: a real directory
 * (not a symlink), owned by `uid`, with no group/other write bits. Never
 * chmod/chown's: a directory we did not create is refused, not repaired.
 * Without a uid (Windows) only the symlink/directory check applies.
 */
export async function ensurePrivateDir(
  dir: string,
  uid: number | undefined,
  refuse: (why: string) => Error,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw refuse('it is not a real directory');
  if (uid !== undefined) {
    if (st.uid !== uid) throw refuse('it is owned by another user');
    if ((st.mode & 0o022) !== 0) throw refuse('it is writable by other users');
  }
}
