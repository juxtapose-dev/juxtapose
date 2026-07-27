#!/usr/bin/env node
// `jux` — the CLI.
//
// Every command is non-interactive and takes --json, because the review loop
// is meant to be closable by an agent as well as a human.

import { parseArgs } from 'node:util';
import { runCommand } from './commands/run.js';
import { approveCommand } from './commands/approve.js';
import { checkCommand } from './commands/check.js';
import { handoffCommand } from './commands/handoff.js';

const USAGE = `
jux — visual regression testing for component workbenches

Usage
  jux run [options]              capture affected stories and compare to baselines
  jux approve [options]          promote current captures to baselines
  jux check [options]            exit non-zero if anything needs review
  jux handoff <storyId>          print an agent prompt for one failing story

Common options
  --json                         machine-readable output on stdout
  --project <dir>                project root (default: cwd)
  --build-dir <dir>              built workbench directory
  --origin <url>                 capture against a running dev server instead
  --platform <name>              storybook | ladle (default: autodetect)
  --concurrency <n>              parallel pages (default: 8)

run
  --since <commit>               only capture stories affected since this commit
  --all                          capture everything, skip affected-analysis
  --comment                      post a summary as a PR comment (GitHub Actions)

approve
  --story <id>                   approve one story (repeatable)
  --all                          approve everything that failed or is new

handoff
  --run <dir>                    run directory to read results from
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean', default: false },
      project: { type: 'string' },
      'build-dir': { type: 'string' },
      origin: { type: 'string' },
      platform: { type: 'string' },
      concurrency: { type: 'string' },
      since: { type: 'string' },
      all: { type: 'boolean', default: false },
      comment: { type: 'boolean', default: false },
      story: { type: 'string', multiple: true },
      run: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });

  switch (command) {
    case 'run':
      return runCommand(values as never);
    case 'approve':
      return approveCommand(values as never);
    case 'check':
      return checkCommand(values as never);
    case 'handoff':
      return handoffCommand(positionals[0], values as never);
    default:
      process.stderr.write(`jux: unknown command '${command}'\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`jux: ${message}\n`);
    process.exit(1);
  });
