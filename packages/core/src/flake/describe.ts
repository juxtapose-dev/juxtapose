// One line for a flake, for every surface that prints one: the run summary,
// `jux diff --runs` and the handoff prompt. The same words everywhere, so an
// agent and a person reading either see the same sentence.

import type { Flake, FlakeConfidence, FlakeFix, FlakeGroup } from '../types.js';

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
  for (const [id, override] of Object.entries(fix.stories ?? {}))
    walk(override, `stories[${JSON.stringify(id)}]`);
  for (const [k, v] of Object.entries(fix)) if (k !== 'stories') walk(v, k);
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
    case 'order-dependence':
      return `a capture ran in a renderer process an earlier story had used (${e.reusedIn?.join(' and ') ?? 'one'} capture)`;
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
  if (f.fix) {
    // A fix outside `stories` changes every story; say so.
    const scope = f.fix.stories ? '' : ' (project setting)';
    return `${head}; fix: ${formatFix(f.fix)}${scope}${caution(f.confidence)}`;
  }
  if (f.cause === 'settle-timeout')
    return `${head}; no safe config change is known: ignore it with settle.network.ignore if it is not content, or raise settle.timeout${caution(f.confidence)}`;
  if (f.cause === 'render-drift')
    return `${head}; no config change helps. Report it as a jux bug and confirm freshRenderer is on${caution(f.confidence)}`;
  return head;
}

/** The patch of a group, as the assignments to make in the project config.
 *  Rules append (`+=`): the config merges arrays, it does not replace them. */
export function formatGroupFix(fix: FlakeFix): string {
  const rules = (fix.network?.rules ?? []).map(
    (r) => `network.rules += ${JSON.stringify(r)}`,
  );
  const { network: _network, ...rest } = fix;
  const others = Object.keys(rest).length > 0 ? [formatFix(rest)] : [];
  return [...rules, ...others].join('; ');
}

/** Story ids as a short list: the first few, then a count. */
export function listStoryIds(ids: string[], max = 6): string {
  return ids.length <= max
    ? ids.join(', ')
    : `${ids.slice(0, max).join(', ')}, and ${ids.length - max} more`;
}

/** One line for a group, in place of one per story. */
export function describeFlakeGroup(g: FlakeGroup): string {
  const what =
    g.cause === 'external-image'
      ? `external images from ${g.host ?? 'a third-party host'}`
      : g.cause === 'embed'
        ? `embedded frames from ${g.host ?? 'a third-party host'}`
        : g.cause === 'order-dependence'
          ? 'captures ran in a renderer process an earlier story had used'
          : g.cause;
  return `${g.storyIds.length} stories: ${what}; fix: ${formatGroupFix(g.fix)}`;
}
