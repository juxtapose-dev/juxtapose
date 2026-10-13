// Where a command's output goes. The CLI writes to the process streams; `jux
// mcp` passes a capturing Io so a tool result is byte-for-byte what
// `jux <command> --json` prints, and nothing a command writes can reach the
// protocol stream on stdout.

import type { Browser } from '@juxtapose/core';

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export const stdio: Io = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
};

/** What a long-lived caller lends a command. Absent fields mean the CLI's
 *  defaults: the process streams, and a browser acquired and closed per call. */
export interface Session {
  io?: Io;
  /** A browser the caller owns. The command uses it and never closes it. */
  browser?: () => Promise<Browser>;
  /** Stops work the command can stop between steps (run: no new stories). */
  signal?: AbortSignal;
}

/** Collects output for one call. */
export function captureIo(): Io & { stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}
