// The per-call settle layer from CLI flags, shared by `jux snap` and
// `jux run`. The top layer: it wins over story params and the project config.

import {
  checkNetwork,
  checkPatterns,
  isSettleTimeout,
  mergeNetwork,
  MAX_SETTLE_TIMEOUT_MS,
  shellQuote,
  type NetworkParams,
  type SettleParams,
} from '@juxtapose/core';

export interface SettleFlags {
  'settle-timeout'?: string;
  'settle-ready'?: boolean;
  /** Turns off a `settle.ready` the story or config sets. */
  'no-settle-ready'?: boolean;
  'settle-ignore'?: string[];
  'settle-require'?: string[];
  /** `allow` or `block`: the config's `network.external`, for this call. */
  'network-external'?: string;
  /** A config `network` object as JSON, for this call. */
  network?: string;
}

/** `network.external` values the flag takes: the string form. Per-type actions and rules are config only. */
const EXTERNAL = ['allow', 'block'] as const;
const isExternal = (v: string): v is (typeof EXTERNAL)[number] =>
  (EXTERNAL as readonly string[]).includes(v);

/** The flags as a `settle` object, undefined when none is set; or the usage
 *  error naming the flag. */
export function settleFromFlags(
  flags: SettleFlags,
  command: string,
): { settle?: SettleParams; network?: NetworkParams } | { error: string } {
  const settle: SettleParams = {};
  const external = flags['network-external'];
  if (external !== undefined && !isExternal(external))
    return {
      error: `${command}: --network-external must be ${EXTERNAL.join(' or ')}, got '${external}'. Try --network-external block.`,
    };
  let network: NetworkParams | undefined;
  if (flags.network !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.network);
    } catch {
      return {
        error: `${command}: --network must be a JSON object like '{"external":{"images":"placeholder"}}', got '${flags.network}'.`,
      };
    }
    try {
      network = checkNetwork(parsed, '--network');
    } catch (e) {
      return { error: `${command}: ${(e as Error).message.replace(/^jux: /, '')}` };
    }
  }
  if (external !== undefined)
    network = mergeNetwork(network, { external }) ?? { external };
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
  const settleNetwork: NonNullable<SettleParams['network']> = {};
  for (const key of ['ignore', 'require'] as const) {
    const list = flags[`settle-${key}`];
    if (!list?.length) continue;
    try {
      settleNetwork[key] = checkPatterns(list, `--settle-${key}`, (m) => new Error(m));
    } catch (e) {
      return { error: `${command}: ${(e as Error).message}` };
    }
  }
  if (settleNetwork.ignore || settleNetwork.require) settle.network = settleNetwork;
  return {
    ...(Object.keys(settle).length > 0 ? { settle } : {}),
    ...(network !== undefined ? { network } : {}),
  };
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
  if (flags.network !== undefined) out.push('--network', shellQuote(flags.network));
  if (flags['network-external'] !== undefined)
    out.push('--network-external', shellQuote(flags['network-external']));
  return out;
}
