// Declaration errors. Their own module because variants.ts and
// settle-options.ts each need the other's checks, and a class extended at
// module evaluation must not sit on an import cycle.

/** A bad variant declaration. The CLI reports it and exits 2. */
export class VariantConfigError extends Error {
  constructor(message: string) {
    super(`jux: ${message}`);
    this.name = 'VariantConfigError';
  }
}

/** A bad settle option. Extends VariantConfigError so every caller that
 *  already reports a declaration error (run, init, the review server) reports
 *  this one the same way: exit 2 with the message. */
export class SettleConfigError extends VariantConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'SettleConfigError';
  }
}
