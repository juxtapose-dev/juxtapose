#!/usr/bin/env node
// `jux` — the CLI.
//
// Every command is non-interactive and takes --json, because the review loop
// is meant to be closable by an agent as well as a human.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { approveCommand } from './commands/approve.js';
import { checkCommand } from './commands/check.js';
import { handoffCommand } from './commands/handoff.js';

const USAGE = `
jux — visual regression testing for component workbenches

Usage
  jux init                       set up juxtapose and capture first baselines
  jux run [options]              capture affected stories and compare to baselines
  jux approve [options]          promote current captures to baselines
  jux check [options]            exit non-zero if anything needs review
  jux handoff <storyId>          print an agent prompt for one failing story
  jux --version                  print installed package versions

Common options
  --json                         machine-readable output on stdout
  --project <dir>                project root (default: cwd)
  --build-dir <dir>              built workbench directory
  --origin <url>                 capture against a running dev server instead
  --platform <name>              storybook | ladle | urls (default: autodetect)
  --concurrency <n>              parallel pages (default: 8)
  --run <dir>                    run directory to read (approve, check, handoff)

run
  --since <commit>               only capture stories affected since this commit
  --all                          capture everything, skip affected-analysis
  --comment                      post a summary as a GitHub PR comment
  --html                         write a self-contained report.html to the run dir

approve
  --story <id>                   approve one story (repeatable)
  --all                          approve everything that failed or is new
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(versions());
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
      html: { type: 'boolean', default: false },
      story: { type: 'string', multiple: true },
      run: { type: 'string' },
    },
  });

  switch (command) {
    case 'init':
      return initCommand(values as never);
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

/**
 * Report every juxtapose package, not just the CLI.
 *
 * They version independently, so one number does not describe the install —
 * and a bug report that says "0.3.0" is ambiguous about which half. Printing
 * the set makes an issue actionable without a follow-up question.
 */
function versions(): string {
  const require = createRequire(import.meta.url);

  // Our own package.json is not reachable through the exports map, so read it
  // relative to this file — dist/index.js sits one level below it.
  const self = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const lines = [`${'@juxtapose/cli'.padEnd(30)} ${self.version}`];

  const names = [
    '@juxtapose/core',
    '@juxtapose/adapter-storybook',
    '@juxtapose/adapter-ladle',
  ];

  for (const name of names) {
    try {
      const pkg = require(`${name}/package.json`) as { version: string };
      lines.push(`${name.padEnd(30)} ${pkg.version}`);
    } catch {
      // Absent is normal — the adapters are optional peers.
      lines.push(`${name.padEnd(30)} (not installed)`);
    }
  }

  lines.push(`${'node'.padEnd(30)} ${process.version}`);
  return lines.join('\n') + '\n';
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`jux: ${message}\n`);
    process.exit(1);
  });
