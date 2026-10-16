import type { CommonFlags } from '../context.js';
import type { Session } from '../io.js';
import { runCommand } from './run.js';

/** Reuse run's complete discovery/variant resolution without taking captures. */
export function listCommand(flags: CommonFlags, session: Session = {}): Promise<number> {
  return runCommand({ ...flags, all: true, 'dry-run': true }, session);
}
