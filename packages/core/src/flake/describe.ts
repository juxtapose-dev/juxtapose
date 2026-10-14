// One line for a flake, for every surface that prints one: the run summary,
// `jux diff --runs` and the handoff prompt. The same words everywhere, so an
// agent and a person reading either see the same sentence.

import type { Flake, FlakeConfidence, FlakeFix } from '../types.js';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The patch as assignments a person can apply by hand:
 *  `stories["card--basic"].network.external.images = "placeholder"`. */
export function formatFix(fix: FlakeFix): string {
  const out: string[] = [];
  const walk = (value: unknown, at: string): void => {
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, at === '' ? k : `${at}.${k}`);
    } else out.push(`${at} = ${JSON.stringify(value)}`);
  };
  // Story ids are keys, not identifiers: write them as `stories["id"]`.
  for (const [id, override] of Object.entries(fix.stories))
    walk(override, `stories[${JSON.stringify(id)}]`);
  return out.join('; ');
}

const caution = (c: FlakeConfidence): string =>
  c === 'high' ? '' : ` (${c} confidence)`;

const first = (s: string | undefined, max = 40): string =>
  s === undefined ? '' : s.length > max ? `${s.slice(0, max - 1)}…` : s;

function what(f: Flake): string {
  const e = f.evidence;
  switch (f.cause) {
    case 'settle-timeout':
      return `settle hit its cap with ${first(e.pending?.[0], 90)}`;
    case 'external-image':
      return `external image from ${e.host ?? 'a third-party host'} in ${e.selector ?? 'the page'}`;
    case 'embed':
      return `embedded frame from ${e.host ?? 'a third-party host'} in ${e.selector ?? 'the page'}`;
    case 'async-element':
      return `${e.selector ?? 'an element'} is in only the ${e.presentIn ?? 'one'} capture`;
    case 'clock':
      return `time text changed in ${e.selector ?? 'the page'} ("${first(e.before)}" to "${first(e.after)}")`;
    case 'random-content':
      return `text changed in ${e.selector ?? 'the page'} ("${first(e.before)}" to "${first(e.after)}")`;
    case 'render-drift':
      return `render drift, identical page structure but ${formatPixels(e.mismatchPercent)} of pixels differ`;
    case 'unknown':
      return `cause unknown${e.mismatchPercent === undefined ? '' : `, ${formatPixels(e.mismatchPercent)} of pixels differ`}`;
  }
}

function formatPixels(percent: number | undefined): string {
  if (percent === undefined) return 'some';
  return `${percent < 0.01 ? '<0.01' : percent.toFixed(2)}%`;
}

export function describeFlake(f: Flake): string {
  const head = `Unstable: ${what(f)}`;
  if (f.fix) return `${head}; fix: ${formatFix(f.fix)}${caution(f.confidence)}`;
  if (f.cause === 'render-drift')
    return `${head}; no config change helps. Report it as a jux bug and confirm freshRenderer is on${caution(f.confidence)}`;
  return head;
}
