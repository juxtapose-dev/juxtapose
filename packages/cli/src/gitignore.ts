// Keep images and run output out of version control.
//
// `jux init` calls this so a project never has to remember the ignore lines:
// a baseline image that slips into a commit is permanent history. The file is
// edited, never rewritten, because it belongs to the project.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** `a`, `/a`, `a/` and `/a/` all ignore the same directory. */
const normalize = (line: string): string =>
  line.trim().replace(/^\/+/, '').replace(/\/+$/, '');

/** The entries `.gitignore` does not already cover. A commented-out line does
 *  not count as present. */
export async function missingIgnores(
  projectRoot: string,
  entries: readonly string[],
): Promise<string[]> {
  const existing = await readGitignore(projectRoot);
  const present = new Set(
    existing
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#'))
      .map(normalize),
  );
  return entries.filter((e) => !present.has(normalize(e)));
}

const readGitignore = (projectRoot: string): Promise<string> =>
  readFile(path.join(projectRoot, '.gitignore'), 'utf8').catch(() => '');

/**
 * Append the entries that `.gitignore` does not already cover and return the
 * ones it added.
 */
export async function ensureIgnored(
  projectRoot: string,
  entries: readonly string[],
): Promise<string[]> {
  const existing = await readGitignore(projectRoot);
  const missing = await missingIgnores(projectRoot, entries);
  if (missing.length === 0) return [];

  // A blank line before our note keeps it visibly separate from the user's own
  // entries; a file that does not end in a newline gets one first.
  const lead = existing === '' ? '' : `${existing.endsWith('\n') ? '' : '\n'}\n`;
  const note = '# juxtapose: baseline images and run output are never committed\n';
  await writeFile(
    path.join(projectRoot, '.gitignore'),
    `${existing}${lead}${note}${missing.map((e) => `${e}\n`).join('')}`,
  );
  return missing;
}
