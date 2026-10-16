import { existsSync } from 'node:fs';
import path from 'node:path';
// Commands init and approve print for a person or agent to paste. The paths in
// them come from the repo's own config, so each is quoted, and `--` ends the
// options so a path can never be read as one.

import { committedPaths, shellQuote, type ProjectConfig } from '@juxtapose/core';

type Storage = ProjectConfig['storage'];

/**
 * A pathspec naming exactly this file or directory. `storage.dir` may contain
 * `* ? [`, which git would expand, so a dir of `*` would stage the whole tree;
 * `:(literal)` makes git read it as a name.
 */
export const literalPathspec = (p: string): string => shellQuote(`:(literal)${p}`);

/**
 * `:(literal)` and `:(glob)` are pathspec magic, which a shell that exports
 * GIT_LITERAL_PATHSPECS=1 makes git read as part of a file name. Printed git
 * commands that use magic turn it off for that one command.
 */
export const NO_LITERAL_ENV = 'GIT_LITERAL_PATHSPECS=0 ';

/** `git add` for the files an approval produces, after `jux init`. */
export function gitAddCommand(
  configName: string,
  storage: Storage,
  projectRoot = process.cwd(),
): string {
  const generated = committedPaths(storage).filter(
    (p) => p !== 'juxtapose.structures' || existsSync(path.join(projectRoot, p)),
  );
  const paths = [configName, ...generated, '.gitignore'];
  return `${NO_LITERAL_ENV}git add -- ${paths.map(literalPathspec).join(' ')}`;
}

/** The paths to commit after `jux approve`, quoted, for a sentence. */
export function commitList(storage: Storage): string {
  return committedPaths(storage).map(shellQuote).join(' and ');
}
