// The per-call recheck mode from CLI flags (`jux run`, `jux config --explain`).
// The top layer: it wins over the project config's `recheck`.

import { RECHECK_MODES, type RecheckMode } from '@juxtapose/core';

export interface RecheckFlags {
  /** `--recheck changed|new|off`. */
  recheck?: string;
  /** `--no-recheck`: the same as `--recheck off`. */
  'no-recheck'?: boolean;
}

/** The mode the flags ask for, undefined when neither is set; or the usage
 *  error naming the flag. */
export function recheckFromFlags(
  flags: RecheckFlags,
  command: string,
): { recheck?: RecheckMode } | { error: string } {
  const given = flags.recheck;
  if (given !== undefined && !(RECHECK_MODES as readonly string[]).includes(given))
    return {
      error: `${command}: --recheck must be ${RECHECK_MODES.join(', ')}, got '${given}'. Try --recheck new.`,
    };
  if (flags['no-recheck'] === true) {
    if (given !== undefined && given !== 'off')
      return {
        error: `${command}: --no-recheck contradicts --recheck ${given}. Pass one of them.`,
      };
    return { recheck: 'off' };
  }
  return given !== undefined ? { recheck: given as RecheckMode } : {};
}
