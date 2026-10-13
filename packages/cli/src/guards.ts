// packages/cli/src/guards.ts
//
// Narrowing for values that arrive as `unknown`: parsed JSON (config, MCP
// messages, snap sets, our own package.json) and caught errors.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A thrown value's message; `String(v)` for a throw that is not an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
