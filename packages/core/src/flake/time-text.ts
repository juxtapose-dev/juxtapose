// Does a piece of text read as a time, a date, or a duration? The clock check
// of the flake classifier. It must be strict: "3 items" or "v1.2" changing is
// random content, not a clock, and masking the wrong thing for the wrong reason
// teaches people to distrust the suggestion.

const MONTHS =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const UNITS =
  'seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?';

const TIME_PATTERNS: readonly RegExp[] = [
  // 10:42, 10:42:07, 10:42 PM. Two-digit minutes keep "3:2" (a ratio) out.
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s?[AP]\.?M\.?)?(?!\d)/i,
  // 2026-10-14
  /\b\d{4}-\d{2}-\d{2}\b/,
  // 10/14/2026, 14/10/26
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  // 14.10.2026 (a four-digit year, so "1.2.34" stays a version)
  /\b\d{1,2}\.\d{1,2}\.\d{4}\b/,
  // Oct 14, 14 Oct. Capitalized only: "may 3" and "mar 2" are ordinary words.
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}\\b`),
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\b`),
  // 5 minutes ago, an hour ago, a few seconds ago
  new RegExp(`\\b(?:\\d+|an?|few)\\s?(?:${UNITS})\\s+ago\\b`, 'i'),
  // in 5 minutes
  new RegExp(`\\bin\\s+\\d+\\s?(?:${UNITS})\\b`, 'i'),
  /\bjust now\b/i,
  // 1h 5m, 2m 30s, 3d 4h
  /\b\d+\s?h\s?\d+\s?m\b/,
  /\b\d+\s?m\s?\d+\s?s\b/,
  /\b\d+\s?d\s?\d+\s?h\b/,
  // Unix seconds or milliseconds, 2017 to 2033
  /\b1[5-9]\d{8}(?:\d{3})?\b/,
];

export function looksLikeTime(text: string): boolean {
  return TIME_PATTERNS.some((p) => p.test(text));
}
