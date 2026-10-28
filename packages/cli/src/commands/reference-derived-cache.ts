import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../guards.js';
const VERSION = 3;
const MAX_ENTRIES = 16;
const MAX_BYTES = 1024 * 1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export function memo<T>(
  entries: Map<string, Promise<T>>,
  key: string,
  produce: () => Promise<T>,
): Promise<T> {
  let result = entries.get(key);
  if (result) {
    entries.delete(key);
    entries.set(key, result);
    return result;
  }
  result = produce();
  entries.set(key, result);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  const pending = result;
  void result.catch(() => {
    if (entries.get(key) === pending) entries.delete(key);
  });
  return result;
}

/** Create/check one component at a time: recursive mkdir through a symlink
 * could write outside the project before a later containment check noticed. */
export async function cacheDirectory(project: string): Promise<string | null> {
  let dir = project;
  try {
    for (const part of ['.juxtapose', 'analysis', `target-layout-v${VERSION}`]) {
      dir = path.join(dir, part);
      try {
        await mkdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      }
      if (!(await lstat(dir)).isDirectory() || (await realpath(dir)) !== dir) return null;
    }
    return dir;
  } catch {
    return null;
  }
}

export async function derived<T extends object>(
  dir: string | null,
  key: string,
  valid: (value: unknown) => value is T,
  produce: () => Promise<T>,
  cacheable: (data: T) => boolean = () => true,
): Promise<T> {
  const file = dir ? path.join(dir, `${key}.json`) : null;
  if (file) {
    try {
      const info = await lstat(file);
      if (info.isFile() && info.size <= MAX_BYTES) {
        const entry: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (
          isRecord(entry) &&
          entry['version'] === VERSION &&
          entry['key'] === key &&
          valid(entry['data']) &&
          entry['checksum'] === hash(JSON.stringify(entry['data']))
        )
          return entry['data'];
      }
    } catch {
      /* absent or corrupt derived cache: recompute */
    }
  }
  const data = await produce();
  if (file && cacheable(data)) {
    const text = JSON.stringify({
      version: VERSION,
      key,
      data,
      checksum: hash(JSON.stringify(data)),
    });
    const temporary = `${file}.${randomUUID()}.tmp`;
    if (Buffer.byteLength(text) <= MAX_BYTES) {
      try {
        await writeFile(temporary, text, { flag: 'wx' });
        await rename(temporary, file);
      } catch {
        /* read-only caches cannot change evidence or verdicts */
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
  }
  return data;
}
