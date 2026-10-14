// jux's own checks inside the config schema: the URL-pattern and CSS-selector
// string formats and the StringEnum kind. TypeBox keeps these in module-level
// registries, so a schema exported from here only validates in a TypeBox that
// has them registered. Ours registers them on load (./validate.ts); another
// copy of TypeBox (a consumer's) passes its own registries to registerFormats.

import { FormatRegistry, TypeRegistry } from '@sinclair/typebox/type';
import { isCssSelector } from '../browser/selectors.js';
import { parsePattern } from '../capture/url-pattern.js';
import {
  CSS_SELECTOR_FORMAT,
  INSTANT_FORMAT,
  STRING_ENUM_KIND,
  URL_PATTERN_FORMAT,
} from './schema.js';

/** A date, or a date-time with its offset: a time without one would be read in
 *  the host's time zone, and the instant would differ between machines. */
const INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Why a value fails a format, or undefined when it passes. The message is
 *  what a config error shows as `{reason}`. */
export const formatReasons: Readonly<Record<string, (v: string) => string | undefined>> =
  {
    [URL_PATTERN_FORMAT]: (v) => {
      try {
        parsePattern(v);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [CSS_SELECTOR_FORMAT]: (v) => (isCssSelector(v) ? undefined : 'not a CSS selector'),
    [INSTANT_FORMAT]: (v) =>
      INSTANT.test(v) && Number.isFinite(Date.parse(v))
        ? undefined
        : `'${v}' is not an ISO 8601 date, or date-time with Z or an offset`,
  };

interface Registries {
  FormatRegistry: Pick<typeof FormatRegistry, 'Has' | 'Set'>;
  TypeRegistry: Pick<typeof TypeRegistry, 'Has' | 'Set'>;
}

/**
 * Register jux's formats and kinds with TypeBox, so `Value.Check` and friends
 * can run the exported schemas (`ProjectConfigSchema`, `SettleSchema`, ...).
 * Idempotent. Pass your own `{ FormatRegistry, TypeRegistry }` (from
 * `@sinclair/typebox`) when your TypeBox is a different copy from core's.
 */
export function registerFormats(
  registries: Registries = { FormatRegistry, TypeRegistry },
): void {
  for (const [name, reason] of Object.entries(formatReasons))
    if (!registries.FormatRegistry.Has(name))
      registries.FormatRegistry.Set(name, (v) => reason(v) === undefined);
  if (!registries.TypeRegistry.Has(STRING_ENUM_KIND))
    registries.TypeRegistry.Set<{ enum: readonly string[] }>(
      STRING_ENUM_KIND,
      (schema, value) => typeof value === 'string' && schema.enum.includes(value),
    );
}
