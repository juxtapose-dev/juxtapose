---
'@juxtapose/cli': patch
---

Reject unknown arguments and add per-command `--help` (#130). `jux run some-story-id` used to ignore the positional and run every story; it now exits 2 with `unexpected argument 'some-story-id'. Did you mean --story some-story-id?`. Unknown flags and extra positionals on every command (`init`, `run`, `approve`, `check`, `handoff`, `snap`, `diff`, `mcp`) exit 2 with a one-line message, and a value flag with no value (`--story`) is an error. `jux <command> --help` and `-h` print that command's usage and exit 0. "could not detect a workbench" and other expected configuration errors print their own message and exit 2 instead of "unexpected failure" and exit 3. Breaking for scripts that passed stray positionals or flags a command does not take: they now fail instead of being ignored.
