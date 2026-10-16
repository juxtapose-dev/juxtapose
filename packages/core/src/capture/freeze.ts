// Deterministic inputs: the clock, randomness and animated images (issues
// #146 and #182).
//
// A story that renders `new Date()`, `Date.now()` or `Math.random()` output
// captures a different value every run, and an animated GIF keeps playing
// under the animation freeze (it stops CSS and Web Animations, not image
// decoding). Under a byte-exact hash each of those is a failed build.
//
// Clock and random are an init script, installed per capture before the
// story's navigation, so they apply before any page script and in the new
// renderer of every cold capture. Images are a browser launch setting
// (flags.ts, `imageAnimationArgs`): Chrome has no per-page switch for image
// animation, so `freeze.images` is project-wide.

import type { Page } from '../browser/page.js';
import { FreezeSchema, type FreezeParams } from '../config/schema.js';
import { validate } from '../config/validate.js';

/**
 * The instant the frozen clock starts at: 2024-01-01T12:00:00Z.
 *
 * Noon UTC, so the calendar date is the same in every time zone from
 * UTC-11 to UTC+11: jux does not pin the time zone (Chrome takes it from the
 * host's TZ), and a midnight instant would render as 31 December on a
 * machine west of Greenwich and 1 January on CI. A Monday, in a leap year,
 * long enough ago that "2 years ago" style relative dates are not "just now".
 */
export const DEFAULT_FROZEN_INSTANT = '2024-01-01T12:00:00.000Z';

/** The built-in defaults, one place to flip them. See docs/configuration.md
 *  for the measurement behind each. */
export const DEFAULT_FREEZE: Required<Pick<FreezeParams, 'random' | 'images'>> & {
  clock: boolean;
} = {
  clock: false,
  random: false,
  images: true,
};

export interface ResolvedFreeze {
  /** Epoch ms the clock starts at, or null for the real clock. */
  clockMs: number | null;
  random: boolean;
  images: boolean;
}

/** `freeze` merged field by field: the upper layer's fields win. */
export function mergeFreeze(
  under: FreezeParams | undefined,
  over: FreezeParams | undefined,
): FreezeParams | undefined {
  if (!under) return over;
  if (!over) return under;
  return { ...under, ...over };
}

/** Validate a story's own `freeze` (clock and random; `images` is the
 *  project's) where it is declared. */
export function checkFreeze(raw: unknown, where: string): FreezeParams | undefined {
  if (raw === undefined) return undefined;
  return validate<FreezeParams>(FreezeSchema, raw, where);
}

/** Epoch ms for a `freeze.clock` value; throws on an instant Date can't parse. */
export function clockInstant(value: boolean | string | undefined): number | null {
  const v = value ?? DEFAULT_FREEZE.clock;
  if (v === false) return null;
  const ms = Date.parse(v === true ? DEFAULT_FROZEN_INSTANT : v);
  if (!Number.isFinite(ms)) throw new Error(`freeze.clock: '${String(v)}' is not a date`);
  return ms;
}

/** Whether the browser should launch with animated images frozen: the
 *  project config's `freeze.images`, else the default. */
export function freezeImages(config: { freeze?: FreezeParams } | undefined): boolean {
  return config?.freeze?.images ?? DEFAULT_FREEZE.images;
}

export function resolveFreeze(freeze: FreezeParams | undefined): ResolvedFreeze {
  return {
    clockMs: clockInstant(freeze?.clock),
    random: freeze?.random ?? DEFAULT_FREEZE.random,
    images: freeze?.images ?? DEFAULT_FREEZE.images,
  };
}

/**
 * The init script. Runs before any page script in every document of the
 * page, after the idle detector's (installed first), so its timer wrappers
 * call through the detector's.
 *
 * The clock starts at the instant and advances only when a timer fires, to
 * that timer's due time (its scheduling instant plus its delay), never with
 * the wall clock. That keeps `new Date()` identical across runs (a story
 * renders the same ISO string down to the millisecond) and still lets code
 * that measures elapsed time with Date move forward: lodash's debounce and
 * throttle re-arm their timer until `Date.now()` has passed the wait, so
 * under a clock that never moves the debounced call never runs.
 *
 * A synchronous loop waiting on the clock (`while (Date.now() - t < 5)`)
 * would never end under a timer-driven clock, since no timer can fire inside
 * it, so past 10,000 reads without a timer the clock steps 1 ms per read.
 * The count is a function of the code path, so the escape is deterministic.
 *
 * `performance.now()`, `requestAnimationFrame` timestamps and event
 * timestamps stay real: settle (idle.ts) measures with them, and a library
 * that animates on them is captured as before.
 *
 * Random: Math.random, crypto.getRandomValues and crypto.randomUUID draw
 * from two fixed-seed sfc32 streams, one for Math.random and one for
 * crypto, so a page that adds a Math.random call does not shift its UUIDs.
 * Separate deterministic streams keep Math.random calls from shifting UUIDs. The
 * native getRandomValues still runs first, so its argument checks and
 * errors are unchanged. Workers keep their own, unseeded, globals.
 */
export function freezeInit(clockMs: number | null, random: boolean): string {
  return `(function () {
  if (window.__juxFreeze) return;
  window.__juxFreeze = true;
  var W = window;
  ${clockMs === null ? '' : clockSource(clockMs)}
  ${random ? RANDOM_SOURCE : ''}
})();`;
}

function clockSource(clockMs: number): string {
  return `
  var T0 = ${clockMs};
  var OD = W.Date;
  var clock = T0, reads = 0, STUCK = 10000;
  var advance = function (t) { if (t > clock) clock = t; reads = 0; };
  var now = function () { if (++reads > STUCK) clock += 1; return clock; };
  {
    var oST = W.setTimeout, oSI = W.setInterval;
    // Web IDL coerces timer delays to signed 32-bit integers; Infinity and
    // overflow must not push Date into an invalid or far-future instant.
    // Coerce once with unary + (including native BigInt/Symbol errors), then
    // pass the primitive to Chrome so object valueOf has no second effect.
    W.setTimeout = function setTimeout(fn, delay) {
      if (typeof fn !== 'function') return oST.apply(W, arguments);
      var delayMs = +delay | 0, due = clock + Math.max(0, delayMs), args = Array.prototype.slice.call(arguments, 2);
      return oST.call(W, function () { advance(due); return fn.apply(W, args); }, delayMs);
    };
    W.setInterval = function setInterval(fn, delay) {
      if (typeof fn !== 'function') return oSI.apply(W, arguments);
      var delayMs = +delay | 0, d = Math.max(0, delayMs), due = clock, args = Array.prototype.slice.call(arguments, 2);
      return oSI.call(W, function () { due += d; advance(due); return fn.apply(W, args); }, delayMs);
    };
  }
  // Date called as a function returns a string; with new, a Date. A subclass
  // (new.target) keeps its own prototype. Same prototype object, so
  // instanceof holds either way round.
  var JD = function Date(y, m, d, h, mi, s, ms) {
    if (!new.target) return new OD(now()).toString();
    var a = arguments.length === 0 ? [now()] : Array.prototype.slice.call(arguments);
    return Reflect.construct(OD, a, new.target === JD ? OD : new.target);
  };
  JD.prototype = OD.prototype;
  JD.now = function now_() { return now(); };
  Object.defineProperty(JD.now, 'name', { value: 'now' });
  JD.parse = OD.parse; JD.UTC = OD.UTC;
  Object.defineProperty(OD.prototype, 'constructor', { value: JD, writable: true, configurable: true });
  W.Date = JD;
  // Formatting "now": Intl.DateTimeFormat's format() and formatToParts()
  // with no date read the system clock, not Date.now.
  var DTF = W.Intl && Intl.DateTimeFormat && Intl.DateTimeFormat.prototype;
  if (DTF) {
    var fmt = Object.getOwnPropertyDescriptor(DTF, 'format');
    if (fmt && fmt.get) Object.defineProperty(DTF, 'format', { configurable: true, enumerable: fmt.enumerable,
      get: function () { var f = fmt.get.call(this); return function (d) { return f(d === undefined ? now() : d); }; } });
    var ftp = DTF.formatToParts;
    if (ftp) DTF.formatToParts = function formatToParts(d) { return ftp.call(this, d === undefined ? now() : d); };
  }
  var TN = W.Temporal && Temporal.Now;
  if (TN) {
    var inst = function () { return Temporal.Instant.fromEpochMilliseconds(now()); };
    var zdt = function (tz) { return inst().toZonedDateTimeISO(tz === undefined ? TN.timeZoneId() : tz); };
    TN.instant = function instant() { return inst(); };
    TN.zonedDateTimeISO = function zonedDateTimeISO(tz) { return zdt(tz); };
    TN.plainDateTimeISO = function plainDateTimeISO(tz) { return zdt(tz).toPlainDateTime(); };
    TN.plainDateISO = function plainDateISO(tz) { return zdt(tz).toPlainDate(); };
    TN.plainTimeISO = function plainTimeISO(tz) { return zdt(tz).toPlainTime(); };
  }`;
}

const RANDOM_SOURCE = `
  // sfc32: 128-bit state, passes PractRand to 2^39 bytes; plenty for a page.
  var sfc32 = function (a, b, c, d) { return function () {
    a |= 0; b |= 0; c |= 0; d |= 0; var t = (a + b | 0) + d | 0; d = d + 1 | 0;
    a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296; }; };
  var warm = function (r) { for (var i = 0; i < 15; i++) r(); return r; };
  var mathRng = warm(sfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x6a09e667));
  var cryptoRng = warm(sfc32(0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822));
  Math.random = function random() { return mathRng(); };
  var CP = W.Crypto && Crypto.prototype;
  if (CP && CP.getRandomValues) {
    var oGRV = CP.getRandomValues;
    var fill = function (arr) { var b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (var i = 0; i < b.length; i++) b[i] = (cryptoRng() * 256) | 0; };
    CP.getRandomValues = function getRandomValues(arr) { var r = oGRV.call(this, arr); fill(arr); return r; };
    if (CP.randomUUID) CP.randomUUID = function randomUUID() {
      var b = new Uint8Array(16); fill(b); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = []; for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
      return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
    };
  }`;

/** The script installed on each page, by its source, and its CDP identifier. */
const installed = new WeakMap<Page, { source: string; id: string | null }>();

/**
 * Install this capture's freeze script for the page's next document, replacing
 * the previous capture's if it differs. Before the story's navigation: the
 * script applies to documents created after it is installed. Returns whether
 * the page's script changed, so a warm switch (same document) can be refused.
 */
export async function applyFreeze(page: Page, freeze: ResolvedFreeze): Promise<boolean> {
  const source =
    freeze.clockMs === null && !freeze.random
      ? ''
      : freezeInit(freeze.clockMs, freeze.random);
  const prev = installed.get(page);
  if (prev?.source === source) return false;
  if (prev?.id)
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: prev.id });
  let id: string | null = null;
  if (source)
    id = await page
      .send('Page.addScriptToEvaluateOnNewDocument', { source })
      .then((r) => r.identifier);
  installed.set(page, { source, id });
  return prev !== undefined;
}

/** Whether the freeze the page's documents get now differs from `freeze`,
 *  without installing anything: a warm switch keeps the document, so it
 *  keeps the clock that document booted with. */
export function freezeChanged(page: Page, freeze: ResolvedFreeze): boolean {
  const prev = installed.get(page);
  if (!prev) return false;
  const source =
    freeze.clockMs === null && !freeze.random
      ? ''
      : freezeInit(freeze.clockMs, freeze.random);
  return prev.source !== source;
}
