// Does a piece of text read as a time, a date, or a duration? The clock check
// of the flake classifier. It must be strict: "3 items" or "v1.2" changing is
// random content, not a clock, and masking the wrong thing for the wrong reason
// teaches people to distrust the suggestion.
//
// Known, accepted over-matches: a label that holds a weekday name or "today"
// ("Monday Motors", "Today's special") reads as a date. The classifier only
// asks when the text CHANGED between two captures, and a changed weekday
// word is a clock far more often than a rename.

const UNITS =
  'seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?';

// Month names that are not ordinary words in the languages below, so "oct 14"
// and "14 octobre" count in any case. English, German, French, Spanish,
// Italian, Portuguese, Dutch; full names and the usual abbreviations.
const MONTHS_SAFE = [
  'jan(?:uary)?',
  'feb(?:ruary)?',
  'apr(?:il)?',
  'june?',
  'july?',
  'aug(?:ust)?',
  'sep(?:t(?:ember)?)?',
  'oct(?:ober)?',
  'nov(?:ember)?',
  'dec(?:ember)?',
  // de
  'januar',
  'jänner',
  'februar',
  'märz',
  'okt(?:ober)?',
  'dez(?:ember)?',
  'juni',
  'juli',
  // fr
  'janv(?:ier)?',
  'févr(?:ier)?',
  'avr(?:il)?',
  'juin',
  'juil(?:let)?',
  'août',
  'sept(?:embre)?',
  'octobre',
  'novembre',
  'déc(?:embre)?',
  // es
  'ene(?:ro)?',
  'febrero',
  'abr(?:il)?',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'dic(?:iembre)?',
  // it
  'gennaio',
  'febbraio',
  'aprile',
  'giugno',
  'luglio',
  'settembre',
  'ottobre',
  'dicembre',
  // pt
  'janeiro',
  'fev(?:ereiro)?',
  'março',
  'junho',
  'julho',
  'setembro',
  'outubro',
  'dezembro',
  // nl
  'januari',
  'februari',
  'mrt',
  'augustus',
  'oktober',
];

// Names that are also ordinary words ("may", "march", Spanish "mar", Dutch
// "mei"): only a Capitalized one next to a day counts ("May 3"), or any case
// next to a four-digit year ("march 2026").
const MONTHS_WORDLIKE = [
  'Mar(?:ch)?',
  'May',
  'Mai',
  'Mars',
  'Marzo',
  'Maart',
  'Mei',
  'Maggio',
  'Maio',
  'Mayo',
];

const safe = MONTHS_SAFE.join('|');
const wordlike = MONTHS_WORDLIKE.join('|');

/** `p` as a whole token: no letter or digit on either side. `\b` would split
 *  "août" and "märz". */
const token = (p: string, flags = 'iu') =>
  new RegExp(`(?<![\\p{L}\\d])(?:${p})(?![\\p{L}\\d])`, flags);

const DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?\.?`;
const OF = String.raw`(?:de\s+|of\s+)?`;
const YEAR = String.raw`(?:19|20)\d{2}`;

const WEEKDAYS =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday|' +
  'montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|' +
  'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|' +
  'lunes|martes|miércoles|jueves|viernes|sábado|domingo|' +
  'lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|' +
  'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag';
// Three-letter forms are ordinary words ("Sun", "Sat"): they count alone, or
// before a number ("Tue 14", "Sat, 10:30").
const WEEKDAY_ABBR = 'Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun';

const TIME_PATTERNS: readonly RegExp[] = [
  // 10:42, 10:42:07, 10:42 PM. Two-digit minutes keep "3:2" (a ratio) out.
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s?[AP]\.?M\.?)?(?!\d)/i,
  // 2026-10-14, 2026/10/14
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:19|20)\d{2}\/\d{1,2}\/\d{1,2}\b/,
  // 10/14/2026, 14/10/26
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  // 14.10.2026 (a four-digit year, so "1.2.34" stays a version)
  /\b\d{1,2}\.\d{1,2}\.\d{4}\b/,
  // Oct 14, 14 Oct, 14. Oktober 2026, 14 de octubre de 2026
  token(`(?:${safe})\\.?\\s+${DAY}`),
  token(`${DAY}\\s+${OF}(?:${safe})`),
  // May 3, 3 March: a Capitalized word-like month beside a day
  token(`(?:${wordlike})\\.?\\s+${DAY}`, 'u'),
  token(`${DAY}\\s+${OF}(?:${wordlike})`, 'u'),
  // "14 march 2026", "march 14, 2026": any case once a year is present
  token(`${DAY}\\s+${OF}(?:${wordlike})\\s+${OF}${YEAR}`, 'iu'),
  token(`(?:${wordlike})\\.?\\s+${DAY},?\\s+${YEAR}`, 'iu'),
  // October 2026, octubre de 2026, march 2026: a month and a year, no day
  token(`(?:${safe}|${wordlike})\\.?,?\\s+${OF}${YEAR}`),
  // 2026年10月14日, 10月14日, 2026年10月, 2026년 10월
  /\d{4}年\s?\d{1,2}月|\d{1,2}月\s?\d{1,2}[日号]|\d{4}년\s?\d{1,2}월/u,
  // Tuesday, Dienstag
  token(WEEKDAYS),
  token(`(?:${WEEKDAY_ABBR})\\.?,?\\s+\\d+`, 'u'),
  /^\s*(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\.?\s*$/,
  // today, yesterday, tomorrow
  token('today|yesterday|tomorrow'),
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
