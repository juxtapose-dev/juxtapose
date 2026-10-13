// packages/core/src/browser/guards.ts
//
// Narrowing for values that arrive as `unknown`: parsed JSON (frames, the
// state file, argv) and caught errors. Small on purpose; anything with a
// shape of its own gets its own guard next to its type.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** `err.code` of a Node system error (ENOENT, EPERM, …), if it has one. */
export function errnoCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const code = err['code'];
  return typeof code === 'string' ? code : undefined;
}

/** A thrown value's message; `String(v)` for a throw that is not an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
