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
import { ManifestConflictError } from '@juxtapose/core';
import { UserError } from './user-error.js';
import { distance } from './suggest.js';
import { BROWSER_HELP } from './commands/browser-help.js';

const HEAD = `
jux — visual regression testing for component workbenches

Usage
  jux init                       set up juxtapose and capture first baselines
  jux run [selector…] [options]  capture affected stories and compare to baselines
  jux list [selector…]           list story IDs, titles and variants without capturing
  jux submit --build-dir <dir> --experimental  submit a compiled Storybook build (preview)
  jux upload --run <directory>   upload an existing run to hosted review
                    --abandon-direct <storyIdSafe>:<attemptId>  explicitly cancel one direct snapshot attempt
                    --recover-direct              inspect existing direct attempts without uploading
  jux approve [options]          promote current captures to baselines
  jux check [options]            exit non-zero if anything needs review
  jux doctor [--fix] [--json]    warn if snapshot images are committed, and print the fix;
                                 --fix migrates inline/legacy structures to readable JSON files
  jux handoff <storyId>          print an agent prompt for one failing story
  jux reference [name] [--run <dir>] [--json]
                                 compare configured design PNGs with a saved run, without capturing
  jux snap <url>… [options]      capture pages: pixels + structure, no workbench
  jux browser install|path|status|start|stop  manage the pinned and warm browser (install downloads once, ~100 MB)
  jux config --explain <storyId> [--json]
                                 the effective capture settings for one story or variant key, and
                                 which layer each came from (config, story, stories glob, variant, CLI)
  jux diff <a> <b> [--json]      what changed between two snaps (or two prefixes with --prefix, two runs with --runs)
  jux mcp [--project <dir>] [--concurrency <n>] [--tools <names>]
                                 MCP server on stdio for coding agents
                                 (--concurrency: snaps at once, 1-16, default half the cores up to 4)
                                 (--tools: exact comma-separated tool names; default all tools)
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
  --run <dir>                    run directory to read (approve, check, handoff, reference, upload)
  --region <id>                  reference: return a saved comparison's paired crop (--json)
  --padding <px>                 reference crop: minimum surrounding context (page pixels)
  --chrome <path>                use this Chromium binary instead of the pinned one (or set JUX_CHROME=<path>)
  --no-daemon                    snap, run, init, approve: launch a private browser instead of the warm one (JUX_NO_DAEMON=1)
  --review-in-github            run: let the required GitHub App check gate visual approval (requires --upload)
  --upload                      run: upload captured results to hosted review (JUXTAPOSE_TOKEN)
  --no-fresh-renderer            snap, run: reuse each page's renderer between captures (config freshRenderer:
                                 false); faster, but a capture can depend on the one before it
`;

const SELECTION_HELP = `
Selection (run, list)
  <selector>…                    exact story IDs or quoted ID globs: 'charts-*'
  --story <selector>             repeatable alternative to positional selectors
                                 base IDs include all variants; variant keys select one capture
                                 globs: * excludes /, ** includes /, ? matches one non-/ character
  --dry-run                      run: show selected IDs/titles without capturing or writing a run
                                 live parameter discovery may open the workbench
  Example: jux run 'charts-*' tables-basic--default --dry-run
`;

const RECHECK_HELP = `
Recheck (run, config)
  --recheck <mode>               which stories get a second capture, so approve can tell a flake from a
                                 stable capture: changed (default: new and failing), new (new only), off
                                 (none; approve confirms instead). Config: recheck
  --no-recheck                   same as --recheck off
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
  --viewport WxH                 snap: viewport size in CSS px, e.g. 1280x800
  --device <name>                snap: emulate a device preset (iphone-15, pixel-8, ipad, ...; or mobile,
                                 tablet, desktop): its size, touch, user agent. Project 'devices' add more
  --orientation portrait|landscape  snap: rotate the viewport (and the device's reported orientation)
  --full-page                    snap: full document, preserving layout viewport
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

const USAGE = `${HEAD}${COMMON}${SELECTION_HELP}${SETTLE_HELP}\n${BROWSER_HELP}\n${DIFF_HELP}`;

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
  if (command === 'submit')
    return (
      text +
      '\n  --project <dir>   Git checkout (default: current directory)\n  --build-dir <dir> Compiled Storybook output\n  --branch <name>   Branch for detached checkouts\n  --experimental    Required experimental opt-in; service must enable the requested feature\n  --pr <number>    Explicit PR identity (check out its exact head SHA)\n  --resume <buildId> Read/wait for an existing build without a checkout or upload\n  --wait            Trigger hosted capture and wait until review publication\n  --wait-preview    Wait only for private preview publication; never request capture\n  --review-in-github Exit 0 after published review handoff; require the Juxtapose App check\n  --wait-timeout <ms> Absolute wait deadline (default 1800000, max 10800000)\n  --poll-interval <ms> Minimum polling interval (250-30000; default 2000)\n  --json            Print the build receipt and, with waiting, workflow or preview status\n'
    );
  text += COMMON;
  if (command === 'run' || command === 'list') text += SELECTION_HELP;
  if (command === 'run' || command === 'config') text += RECHECK_HELP;
  if (command === 'run' || command === 'snap' || command === 'config')
    text += SETTLE_HELP;
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
      tools: { type: 'string' },
      since: { type: 'string' },
      all: { type: 'boolean', default: false },
      fix: { type: 'boolean', default: false },
      'allow-unstable': { type: 'boolean', default: false },
      comment: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
      upload: { type: 'boolean', default: false },
      experimental: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      'wait-preview': { type: 'boolean', default: false },
      resume: { type: 'string' },
      'wait-timeout': { type: 'string' },
      'poll-interval': { type: 'string' },
      branch: { type: 'string' },
      pr: { type: 'string' },
      'review-in-github': { type: 'boolean', default: false },
      story: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
      run: { type: 'string' },
      'abandon-direct': { type: 'string' },
      'recover-direct': { type: 'boolean', default: false },
      region: { type: 'string' },
      padding: { type: 'string' },
      as: { type: 'string' },
      'as-prefix': { type: 'string' },
      prefix: { type: 'boolean', default: false },
      runs: { type: 'boolean', default: false },
      viewport: { type: 'string' },
      device: { type: 'string' },
      orientation: { type: 'string' },
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
      'full-page': { type: 'boolean', default: false },
      recheck: { type: 'string' },
      'no-recheck': { type: 'boolean', default: false },
      explain: { type: 'string' },
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
  if (command === 'run' || command === 'list')
    values.story = [...(values.story ?? []), ...positionals];
  const flags = values as never;

  switch (command) {
    case 'init': {
      const { initCommand } = await import('./commands/init.js');
      return initCommand(flags);
    }
    case 'submit': {
      const { submitCommand } = await import('./commands/submit.js');
      return submitCommand(flags);
    }
    case 'upload': {
      const { uploadCommand } = await import('./commands/upload.js');
      return uploadCommand(flags);
    }
    case 'run': {
      const { runCommand } = await import('./commands/run.js');
      return runCommand(flags);
    }
    case 'list': {
      const { listCommand } = await import('./commands/list.js');
      return listCommand(flags);
    }
    case 'approve': {
      const { approveCommand } = await import('./commands/approve.js');
      return approveCommand(flags);
    }
    case 'check': {
      const { checkCommand } = await import('./commands/check.js');
      return checkCommand(flags);
    }
    case 'doctor': {
      const { doctorCommand } = await import('./commands/doctor.js');
      return doctorCommand(flags);
    }
    case 'handoff': {
      const { handoffCommand } = await import('./commands/handoff.js');
      return handoffCommand(positionals[0], flags);
    }
    case 'reference': {
      const { referenceCommand } = await import('./commands/reference.js');
      return referenceCommand(positionals[0], flags);
    }
    case 'snap': {
      const { snapCommand } = await import('./commands/snap.js');
      return snapCommand(positionals, flags);
    }
    case 'browser': {
      const { browserCommand } = await import('./commands/browser.js');
      return browserCommand(argv.slice(1), values.json === true);
    }
    case 'config': {
      const { configCommand } = await import('./commands/config.js');
      return configCommand(flags);
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
  'submit',
  'run',
  'list',
  'approve',
  'check',
  'handoff',
  'reference',
  'snap',
  'config',
  'diff',
  'browser',
  'mcp',
];

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
    // The lockfile guidance is the whole message; it is the user's to act on.
    if (err instanceof ManifestConflictError) {
      process.stderr.write(`jux: ${err.message}\n`);
      return exitAfterFlush(EXIT.usage);
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
