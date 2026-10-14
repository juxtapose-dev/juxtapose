#!/usr/bin/env node
// `jux` — the CLI.
//
// Every command is non-interactive and takes --json, because the review loop
// is meant to be closable by an agent as well as a human.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { EXIT } from './exit-codes.js';
import { isRecord } from './guards.js';
import { checkArgs, SPECS } from './cli-args.js';
import { UserError } from './user-error.js';
import { BROWSER_HELP } from './commands/browser-help.js';

const HEAD = `
jux — visual regression testing for component workbenches

Usage
  jux init                       set up juxtapose and capture first baselines
  jux run [options]              capture affected stories and compare to baselines
  jux approve [options]          promote current captures to baselines
  jux check [options]            exit non-zero if anything needs review
  jux handoff <storyId>          print an agent prompt for one failing story
  jux snap <url>… [options]      capture pages: pixels + structure, no workbench
  jux browser install|path|status|start|stop  manage the pinned and warm browser (install downloads once, ~100 MB)
  jux diff <a> <b> [--json]      what changed between two snaps (or two prefixes with --prefix, two runs with --runs)
  jux mcp [--project <dir>] [--concurrency <n>]
                                 MCP server on stdio for coding agents: snap, diff, run, check, handoff, approve
                                 (--concurrency: snaps at once, 1-16, default half the cores up to 4)
  jux --version                  print installed package versions
`;

const COMMON = `
Common options
  --json                         machine-readable output on stdout
  --project <dir>                project root (default: cwd)
  --build-dir <dir>              built workbench directory
  --origin <url>                 capture against a running dev server instead
  --platform <name>              storybook | ladle | urls (default: autodetect)
  --concurrency <n>              parallel pages (default: 8)
  --allow-unstable               approve: also baseline stories whose two run captures differed
  --run <dir>                    run directory to read (approve, check, handoff)
  --chrome <path>                use this Chromium binary instead of the pinned one (or set JUX_CHROME=<path>)
  --no-daemon                    snap, run, init: launch a private browser instead of the warm one (JUX_NO_DAEMON=1)
  --no-fresh-renderer            snap, run: reuse each page's renderer between captures (config freshRenderer:
                                 false); faster, but a capture can depend on the one before it
`;

const SETTLE_HELP = `
Settle options (snap, run; over the story's and the config's settle)
  --settle-timeout <ms>          cap on the wait for the page to finish, 1-60000 (default 1500); a
                                 capture at the cap is flagged settle-timeout with what was pending
  --settle-ready                 also wait for the page to call window.__juxtapose.ready()
  --no-settle-ready              don't, even if the story or config says to
  --settle-ignore <pattern>      never wait for matching requests (repeatable)
  --settle-require <pattern>     wait until a matching request completes (repeatable)
                                 pattern: [type:<ResourceType>] [<glob>]; a glob starting with /
                                 matches the path, e.g. '/api/feed' or 'type:Fetch **/poll*'
  --network-external <mode>      allow (default) or block: block fails requests to origins other than
                                 the page's own, so a third-party image neither changes nor stalls the capture;
                                 applies to every resource type, overriding per-type entries from lower layers
  --network <json>               a config network object for this call: per-type actions and URL rules,
                                 e.g. '{"external":{"images":"placeholder"},"rules":[{"match":"https://ads.*/**","action":"block"}]}'
  --delay <ms>                   snap: fixed extra wait after settling; last resort
`;

const DIFF_HELP = `diff
  <a>, <b>                       snap names (from --as), or paths to .webp files
  --prefix                       pair <a>-<slug> with <b>-<slug> and verdict every page
  --runs                         <a>, <b> are run ids (under .juxtapose/runs) or run directories:
                                 compare each story's capture hash, no browser. Prints identical and
                                 different counts and the differing story ids; --json is
                                 juxtapose.run-diff/v1 {a, b, summary, different[], missing[]}
                                 (missing: a story in only one run). Exit 0 identical, 1 otherwise.
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

const USAGE = `${HEAD}${COMMON}${SETTLE_HELP}\n${BROWSER_HELP}\n${DIFF_HELP}`;

/** One command's usage: its lines from the list, then the options it takes. */
function commandHelp(command: string): string {
  const lines = HEAD.split('\n');
  const out: string[] = [];
  let on = false;
  for (const line of lines) {
    if (line.startsWith('  jux '))
      on = line.startsWith(`  jux ${command} `) || line === `  jux ${command}`;
    else if (!line.startsWith(' '.repeat(20))) on = false;
    if (on) out.push(line);
  }
  let text = `Usage\n${out.join('\n')}\n`;
  if (command === 'browser') return text + '\n' + BROWSER_HELP;
  text += COMMON;
  if (command === 'run' || command === 'snap') text += SETTLE_HELP;
  if (command === 'diff') text += '\n' + DIFF_HELP;
  return text;
}

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
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean', default: false },
      project: { type: 'string' },
      'build-dir': { type: 'string' },
      origin: { type: 'string' },
      platform: { type: 'string' },
      concurrency: { type: 'string' },
      since: { type: 'string' },
      all: { type: 'boolean', default: false },
      'allow-unstable': { type: 'boolean', default: false },
      comment: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
      story: { type: 'string', multiple: true },
      run: { type: 'string' },
      as: { type: 'string' },
      'as-prefix': { type: 'string' },
      prefix: { type: 'boolean', default: false },
      runs: { type: 'boolean', default: false },
      viewport: { type: 'string' },
      'wait-for': { type: 'string' },
      delay: { type: 'string' },
      'settle-timeout': { type: 'string' },
      'settle-ready': { type: 'boolean', default: false },
      'no-settle-ready': { type: 'boolean', default: false },
      'settle-ignore': { type: 'string', multiple: true },
      'settle-require': { type: 'string', multiple: true },
      'network-external': { type: 'string' },
      network: { type: 'string' },
      mask: { type: 'string', multiple: true },
      crops: { type: 'boolean', default: false },
      chrome: { type: 'string' },
      'no-daemon': { type: 'boolean', default: false },
      'no-fresh-renderer': { type: 'boolean', default: false },
    },
  });

  if (command !== 'browser' && SPECS[command]) {
    if (values.help === true) {
      process.stdout.write(commandHelp(command));
      return EXIT.clean;
    }
    const problem = checkArgs(command, values, positionals);
    if (problem) {
      process.stderr.write(`${problem}\n`);
      return EXIT.usage;
    }
  }

  // strict: false (unknown flags pass through) makes parseArgs type every
  // value `string | boolean`, since `--json=yes` is legal there. Each command
  // declares the flag types the usage documents; this one cast is where that
  // claim is made, instead of one per command.
  const flags = values as never;

  switch (command) {
    case 'init': {
      const { initCommand } = await import('./commands/init.js');
      return initCommand(flags);
    }
    case 'run': {
      const { runCommand } = await import('./commands/run.js');
      return runCommand(flags);
    }
    case 'approve': {
      const { approveCommand } = await import('./commands/approve.js');
      return approveCommand(flags);
    }
    case 'check': {
      const { checkCommand } = await import('./commands/check.js');
      return checkCommand(flags);
    }
    case 'handoff': {
      const { handoffCommand } = await import('./commands/handoff.js');
      return handoffCommand(positionals[0], flags);
    }
    case 'snap': {
      const { snapCommand } = await import('./commands/snap.js');
      return snapCommand(positionals, flags);
    }
    case 'browser': {
      const { browserCommand } = await import('./commands/browser.js');
      return browserCommand(argv.slice(1), values.json === true);
    }
    case 'diff': {
      const { diffCommand } = await import('./commands/diff.js');
      return diffCommand(positionals[0], positionals[1], flags);
    }
    case 'mcp': {
      const { mcpCommand } = await import('./commands/mcp.js');
      return mcpCommand(flags, selfVersion());
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
  // Every row has b.length + 1 cells and j stays within 1..b.length, so the
  // indexed reads below are always in range.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length]!;
}

/** " Did you mean 'diff'?" when a command is within edit distance 2. */
function suggest(command: string): string {
  // The first closest command, as the stable sort used to pick.
  let best: { c: string; d: number } | undefined;
  for (const c of COMMANDS) {
    const d = distance(command, c);
    if (!best || d < best.d) best = { c, d };
  }
  return best && best.d <= 2 ? ` Did you mean '${best.c}'?` : '';
}

/** A package.json's version; '(unknown)' when it has none (it always does). */
function packageVersion(pkg: unknown): string {
  return isRecord(pkg) && typeof pkg['version'] === 'string'
    ? pkg['version']
    : '(unknown)';
}

function selfVersion(): string {
  // Our own package.json is not reachable through the exports map, so read it
  // relative to this file — dist/index.js sits one level below it.
  return packageVersion(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  );
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
      const pkg: unknown = require(`${name}/package.json`);
      lines.push(`${name.padEnd(30)} ${packageVersion(pkg)}`);
    } catch {
      // Absent is normal — the adapters are optional peers.
      lines.push(`${name.padEnd(30)} (not installed)`);
    }
  }

  lines.push(`${'node'.padEnd(30)} ${process.version}`);
  return lines.join('\n') + '\n';
}

/** A reader that stalls longer than this loses the tail rather than hanging us. */
const FLUSH_LIMIT_MS = 30_000;

/**
 * Exit once everything written to stdout and stderr has left the process.
 *
 * Pipes are asynchronous on macOS: `process.stdout.write` returns before the
 * bytes are in the pipe, and `process.exit()` discards what is still queued, so
 * a reader that is slower than us saw output cut at 64 KiB (#135). We still
 * call `process.exit` rather than set `process.exitCode`, because the warm
 * browser daemon connection can hold the event loop open. An empty write
 * completes only after every earlier write on that stream has, which is the
 * drain signal. Bounded, so a reader that never reads cannot hang the process.
 */
async function exitAfterFlush(code: number): Promise<never> {
  const drained = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stream.destroyed || !stream.writable) return resolve();
      stream.once('error', () => resolve());
      stream.write('', () => resolve());
    });
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_LIMIT_MS);
  });
  await Promise.race([
    Promise.all([drained(process.stdout), drained(process.stderr)]),
    limit,
  ]);
  clearTimeout(timer);
  process.exit(code);
}

main(process.argv.slice(2))
  .then((code) => exitAfterFlush(code))
  .catch((err: unknown) => {
    if (err instanceof UserError) {
      process.stderr.write(`jux: ${err.message}\n`);
      return exitAfterFlush(err.exit);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `jux: ${message}\nunexpected failure; re-run with JUX_DEBUG=1 for the stack trace, or report it at https://github.com/juxtapose-dev/juxtapose/issues\n`,
    );
    if (process.env.JUX_DEBUG && err instanceof Error && err.stack)
      process.stderr.write(`${err.stack}\n`);
    // An unhandled throw is a tool failure, not "needs review".
    return exitAfterFlush(EXIT.failure);
  });
