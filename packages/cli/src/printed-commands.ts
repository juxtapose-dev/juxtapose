// Commands init and approve print for a person or agent to paste. The paths in
// them come from the repo's own config, so each is quoted, and `--` ends the
// options so a path can never be read as one.

import { committedPaths, shellQuote, type ProjectConfig } from '@juxtapose/core';

type Storage = ProjectConfig['storage'];

/** `git add` for the files an approval produces, after `jux init`. */
export function gitAddCommand(configName: string, storage: Storage): string {
  const paths = [configName, ...committedPaths(storage), '.gitignore'];
  return `git add -- ${paths.map(shellQuote).join(' ')}`;
}

/** The paths to commit after `jux approve`, quoted, for a sentence. */
export function commitList(storage: Storage): string {
  return committedPaths(storage).map(shellQuote).join(' and ');
}
