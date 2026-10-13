// packages/core/src/browser/__tests__/helpers.ts
import { resolveChrome, type ResolvedChrome } from '../resolve.js';

/** The pinned browser if this machine has one; integration tests skip otherwise. */
export function chromeForTests(): ResolvedChrome | null {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
}
