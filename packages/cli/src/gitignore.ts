// Keep images and run output out of version control.
//
// `jux init` calls this so a project never has to remember the ignore lines:
// a baseline image that slips into a commit is permanent history. The file is
// edited, never rewritten, because it belongs to the project.

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// `git check-ignore` takes paths, not pathspecs, so nothing here is expanded
// (and it refuses GIT_LITERAL_PATHSPECS outright).
import path from 'node:path';

/** `a`, `/a`, `a/` and `/a/` all ignore the same directory. */
const normalize = (line: string): string =>
  line.trim().replace(/^\/+/, '').replace(/\/+$/, '');

/** A path that `entry` is meant to cover, for asking git about it. */
const sampleFor = (entry: string): string =>
  entry.endsWith('/') ? `${entry}x` : entry.replaceAll('*', 'x');

/**
 * `true`/`false` when git can say whether `sample` is ignored (any pattern,
 * any parent `.gitignore`, the global excludes), `undefined` outside a repo.
 * `--no-index` so a still-tracked file counts as covered by the pattern.
 */
function gitIgnores(projectRoot: string, sample: string): boolean | undefined {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', sample], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    return (err as { status?: number }).status === 1 ? false : undefined;
  }
}

/** The entries not already covered. Git decides when it can, so a broader
 *  pattern (`.juxtapose/`) or a parent `.gitignore` counts; outside a repo the
 *  file's own lines are compared, and a commented-out line never counts. */
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
  return entries.filter(
    (e) => !(gitIgnores(projectRoot, sampleFor(e)) ?? present.has(normalize(e))),
  );
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

/** Files jux needs committed; a path that git ignores here silently drops out
 *  of every `git add`, and CI loses the structure diffs without a word. */
const COMMITTED_SAMPLES = ['juxtapose.manifest.json', 'juxtapose.config.json'];

export interface IgnoredCommitted {
  /** The sample path git would ignore. */
  path: string;
  /** Which ignore file, line and pattern did it, when git said. */
  source?: string;
  pattern?: string;
}

/** Which of the committed paths git ignores (empty outside a repo). */
export function ignoredCommittedPaths(projectRoot: string): IgnoredCommitted[] {
  const out: IgnoredCommitted[] = [];
  for (const sample of COMMITTED_SAMPLES) {
    try {
      const line = execFileSync(
        'git',
        ['check-ignore', '-v', '--no-index', '--', sample],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      // "<source>:<line>:<pattern>\t<path>"
      const m = /^(.*?):\d+:(.*)\t/.exec(line);
      out.push({ path: sample, ...(m ? { source: m[1], pattern: m[2] } : {}) });
    } catch {
      // exit 1: not ignored; anything else: not a repo. Neither is a finding.
    }
  }
  return out;
}
