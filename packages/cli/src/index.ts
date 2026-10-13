#!/usr/bin/env node
// `jux` — the CLI.
//
// Every command is non-interactive and takes --json, because the review loop
// is meant to be closable by an agent as well as a human.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { EXIT } from './exit-codes.js';
import { BROWSER_HELP } from './commands/browser-help.js';

const USAGE = `
jux — visual regression testing for component workbenches

Usage
  jux init                       set up juxtapose and capture first baselines
  jux run [options]              capture affected stories and compare to baselines
  jux approve [options]          promote current captures to baselines
  jux check [options]            exit non-zero if anything needs review
  jux handoff <storyId>          print an agent prompt for one failing story
  jux snap <url>… [options]      capture pages: pixels + structure, no workbench
  jux browser install|path|status|start|stop  manage the pinned and warm browser (install downloads once, ~100 MB)
  jux diff <a> <b> [--json]      what changed between two snaps (or two prefixes with --prefix)
  jux mcp [--project <dir>]      MCP server on stdio for coding agents: snap, diff, run, check, handoff, approve
  jux --version                  print installed package versions

Common options
  --json                         machine-readable output on stdout
  --project <dir>                project root (default: cwd)
  --build-dir <dir>              built workbench directory
  --origin <url>                 capture against a running dev server instead
  --platform <name>              storybook | ladle | urls (default: autodetect)
  --concurrency <n>              parallel pages (default: 8)
  --run <dir>                    run directory to read (approve, check, handoff)
  --chrome <path>                use this Chromium binary instead of the pinned one (or set JUX_CHROME=<path>)
  --no-daemon                    snap, run, init: launch a private browser instead of the warm one (JUX_NO_DAEMON=1)

${BROWSER_HELP}
diff
  <a>, <b>                       snap names (from --as), or paths to .webp files
  --prefix                       pair <a>-<slug> with <b>-<slug> and verdict every page
  --json                         the verdict as juxtapose.verdict/v1 JSON (byte-stable)
  --crops                        also write side-by-side strips (baseline | current) per changed
                                 region, unexplained first, to .juxtapose/crops/<a>~vs~<b>/ and list
                                 them; --json wraps the verdict as juxtapose.crops/v1. No browser.
  --prefix output is juxtapose.verdict-set/v1: pages[] (a verdict each), missing[] (unpaired
    slugs), errors[] ({slug, code, file}; code is snap-missing | sidecar-undecodable |
    image-undecodable | pair-undecodable; file is the snap file name, null for
    pair-undecodable) and summary {identical, different, missing, errored}; one bad pair
    never hides the others
  exit 0 identical · 1 different or unpaired · 2 usage · 3 could not read an input
  (with --prefix, 3 beats 1 beats 0: any errored pair makes the exit 3)
snap exit: 0 all written · 2 usage · 3 browser or any page failed (the rest are still written)

The agent loop, no workbench needed:
  jux snap http://localhost:5173/ http://localhost:5173/settings --as-prefix before
  # …edit code…
  jux snap http://localhost:5173/ http://localhost:5173/settings --as-prefix after && jux diff --prefix before after
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
      as: { type: 'string' },
      'as-prefix': { type: 'string' },
      prefix: { type: 'boolean', default: false },
      viewport: { type: 'string' },
      'wait-for': { type: 'string' },
      mask: { type: 'string', multiple: true },
      crops: { type: 'boolean', default: false },
      chrome: { type: 'string' },
      'no-daemon': { type: 'boolean', default: false },
    },
  });

  switch (command) {
    case 'init': {
      const { initCommand } = await import('./commands/init.js');
      return initCommand(values as never);
    }
    case 'run': {
      const { runCommand } = await import('./commands/run.js');
      return runCommand(values as never);
    }
    case 'approve': {
      const { approveCommand } = await import('./commands/approve.js');
      return approveCommand(values as never);
    }
    case 'check': {
      const { checkCommand } = await import('./commands/check.js');
      return checkCommand(values as never);
    }
    case 'handoff': {
      const { handoffCommand } = await import('./commands/handoff.js');
      return handoffCommand(positionals[0], values as never);
    }
    case 'snap': {
      const { snapCommand } = await import('./commands/snap.js');
      return snapCommand(positionals, values as never);
    }
    case 'browser': {
      const { browserCommand } = await import('./commands/browser.js');
      return browserCommand(argv.slice(1), values.json === true);
    }
    case 'diff': {
      const { diffCommand } = await import('./commands/diff.js');
      return diffCommand(positionals[0], positionals[1], values as never);
    }
    case 'mcp': {
      const { mcpCommand } = await import('./commands/mcp.js');
      return mcpCommand(values as never, selfVersion());
    }
    default:
      process.stderr.write(
        `jux: unknown command '${command}'.${suggest(command)} Run \`jux --help\`.\n`,
      );
      return EXIT.usage;
  }
}

const COMMANDS = [
  'init',
  'run',
  'approve',
  'check',
  'handoff',
  'snap',
  'diff',
  'browser',
  'mcp',
];

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length];
}

/** " Did you mean 'diff'?" when a command is within edit distance 2. */
function suggest(command: string): string {
  const best = COMMANDS.map((c) => ({ c, d: distance(command, c) })).sort(
    (x, y) => x.d - y.d,
  )[0];
  return best.d <= 2 ? ` Did you mean '${best.c}'?` : '';
}

function selfVersion(): string {
  // Our own package.json is not reachable through the exports map, so read it
  // relative to this file — dist/index.js sits one level below it.
  return (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
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

  const lines = [`${'@juxtapose/cli'.padEnd(30)} ${selfVersion()}`];

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
    process.stderr.write(
      `jux: ${message}\nunexpected failure; re-run with JUX_DEBUG=1 for the stack trace, or report it at https://github.com/juxtapose-dev/juxtapose/issues\n`,
    );
    if (process.env.JUX_DEBUG && err instanceof Error && err.stack)
      process.stderr.write(`${err.stack}\n`);
    // An unhandled throw is a tool failure, not "needs review".
    process.exit(EXIT.failure);
  });
