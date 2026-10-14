// When many stories flake for one reason, the fix is one project setting, not
// one patch per story. A group needs MIN_GROUP stories: below that the
// per-story lines are shorter than the group's.

import { compareCodeUnits } from '../report/format.js';
import type { Flake, FlakeCause, FlakeFix, FlakeGroup } from '../types.js';

export const MIN_GROUP = 3;

/** The causes whose fix can be stated once per third-party host. */
const HOSTED: ReadonlySet<FlakeCause> = new Set(['external-image', 'embed']);

/** `type:Image https://picsum.photos/**` from the evidence's URL, or undefined when the
 *  flake has none (a group is then not possible). */
function hostRule(flake: Flake): string | undefined {
  try {
    // Typed: an untyped placeholder rule turns a script or stylesheet from the
    // host into a block (decide() has no stand-in for them), which would
    // break every story that loads one.
    const type = flake.cause === 'embed' ? 'Document' : 'Image';
    return `type:${type} ${new URL(flake.evidence.url ?? '').origin}/**`;
  } catch {
    return undefined;
  }
}

export function groupFlakes(
  entries: ReadonlyArray<{ storyId: string; flake: Flake }>,
): FlakeGroup[] {
  const buckets = new Map<
    string,
    { cause: FlakeCause; host?: string; fix: FlakeFix; storyIds: string[] }
  >();
  for (const { storyId, flake } of entries) {
    let key: string;
    let host: string | undefined;
    let fix: FlakeFix;
    if (HOSTED.has(flake.cause)) {
      const match = hostRule(flake);
      host = flake.evidence.host;
      if (!match || !host) continue;
      key = `${flake.cause}\0${host}`;
      // `placeholder` answers an image or a frame and blocks anything else, so
      // one rule per host covers every resource type that host serves.
      fix = { network: { rules: [{ match, action: 'placeholder' }] } };
    } else if (flake.cause === 'order-dependence') {
      key = flake.cause;
      fix = { freshRenderer: true };
    } else continue;
    const b = buckets.get(key) ?? {
      cause: flake.cause,
      ...(host ? { host } : {}),
      fix,
      storyIds: [],
    };
    b.storyIds.push(storyId);
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .filter((b) => b.storyIds.length >= MIN_GROUP)
    .map((b) => ({ ...b, storyIds: b.storyIds.sort(compareCodeUnits) }))
    .sort(
      (a, b) =>
        b.storyIds.length - a.storyIds.length ||
        compareCodeUnits(`${a.cause}${a.host ?? ''}`, `${b.cause}${b.host ?? ''}`),
    );
}
