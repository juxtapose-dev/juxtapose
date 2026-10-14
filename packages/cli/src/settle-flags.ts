// The per-call settle layer from CLI flags, shared by `jux snap` and
// `jux run`. The top layer: it wins over story params and the project config.

import {
  checkPatterns,
  isSettleTimeout,
  MAX_SETTLE_TIMEOUT_MS,
  shellQuote,
  type SettleParams,
} from '@juxtapose/core';

export interface SettleFlags {
  'settle-timeout'?: string;
  'settle-ready'?: boolean;
  /** Turns off a `settle.ready` the story or config sets. */
  'no-settle-ready'?: boolean;
  'settle-ignore'?: string[];
  'settle-require'?: string[];
}

/** The flags as a `settle` object, undefined when none is set; or the usage
 *  error naming the flag. */
export function settleFromFlags(
  flags: SettleFlags,
  command: string,
): { settle?: SettleParams } | { error: string } {
  const settle: SettleParams = {};
  const raw = flags['settle-timeout'];
  if (raw !== undefined) {
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!isSettleTimeout(n))
      return {
        error: `${command}: --settle-timeout must be a whole number of ms from 1 to ${MAX_SETTLE_TIMEOUT_MS}, got '${raw}'. Try --settle-timeout 3000.`,
      };
    settle.timeout = n;
  }
  if (flags['settle-ready'] === true && flags['no-settle-ready'] === true)
    return { error: `${command}: use --settle-ready or --no-settle-ready, not both.` };
  if (flags['settle-ready'] === true) settle.ready = true;
  if (flags['no-settle-ready'] === true) settle.ready = false;
  const network: NonNullable<SettleParams['network']> = {};
  for (const key of ['ignore', 'require'] as const) {
    const list = flags[`settle-${key}`];
    if (!list?.length) continue;
    try {
      network[key] = checkPatterns(list, `--settle-${key}`, (m) => new Error(m));
    } catch (e) {
      return { error: `${command}: ${(e as Error).message}` };
    }
  }
  if (network.ignore || network.require) settle.network = network;
  return Object.keys(settle).length > 0 ? { settle } : {};
}

/** The flags again, for a retry command that must repeat them. */
export function settleFlagArgs(flags: SettleFlags): string[] {
  const out: string[] = [];
  if (flags['settle-timeout'] !== undefined)
    out.push('--settle-timeout', shellQuote(flags['settle-timeout']));
  if (flags['settle-ready'] === true) out.push('--settle-ready');
  if (flags['no-settle-ready'] === true) out.push('--no-settle-ready');
  for (const p of flags['settle-ignore'] ?? [])
    out.push('--settle-ignore', shellQuote(p));
  for (const p of flags['settle-require'] ?? [])
    out.push('--settle-require', shellQuote(p));
  return out;
}
