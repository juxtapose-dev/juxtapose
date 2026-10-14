import { EXIT } from './exit-codes.js';

/**
 * A problem the user can fix (no workbench, unknown platform): reported as one
 * line with its own exit code, never as "unexpected failure".
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly exit: number = EXIT.usage,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
