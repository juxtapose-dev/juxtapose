// Why did two captures of one story differ, and what config change fixes it?
//
// Pure: it reads observations (analyze.ts derives them from two captures) and
// returns a verdict. The checks run in a fixed order and the first confident
// match wins, because the causes overlap: a request still pending at the settle
// cap also leaves text half-rendered, and an image from a random-photo service
// also shows up as a "changed region". Third-party images and frames that sit
// in the changed pixels come first (the pixels name them), then what the settle
// wait was stuck on; a pending request alone is often the page's own
// background traffic, which no fix should touch.

import type {
  CaptureFlag,
  ExternalRef,
  Flake,
  FlakeConfidence,
  FlakeFix,
  FlakeSide,
  PendingRequest,
  StoryOverride,
} from '../types.js';
import type { NetworkRule } from '../config/schema.js';
import { looksLikeTime } from './time-text.js';

/** An element with a third-party resource, whose box overlaps the pixels that
 *  differ between the two captures. */
export interface ExternalHit {
  selector: string;
  ref: ExternalRef;
  /** Area of the element's box inside the changed regions, px². Orders hits. */
  overlap: number;
}

export interface TextChange {
  selector: string;
  before: string;
  after: string;
}

/** An element in one capture's structure with no counterpart in the other. */
export interface OneSidedElement {
  selector: string;
  presentIn: FlakeSide;
  /** Box area, px²: the biggest one is the most telling. */
  area: number;
  /** The selector rests on a test id, id or class, not on the element's
   *  position among its siblings. */
  stable: boolean;
}

/** Which third-party requests the story's network config already answers. A
 *  covered type cannot be the source of a difference, and suggesting the same
 *  setting again would send the reader in a circle. */
export interface NetworkCoverage {
  images: boolean;
  frames: boolean;
  /** Whether the config already answers this particular resource, through a
   *  `network.rules` entry (a group rule for its host) as well as the type
   *  map. Unset when only the flags are known. */
  covers?: (ref: ExternalRef) => boolean;
}

export interface FlakeObservations {
  storyId: string;
  /** What each capture's settle wait was still waiting on at its cap. */
  settlePending: string[];
  /** A capture's settle wait hit its cap. */
  settleTimedOut: boolean;
  /** The requests still in flight, by full URL, from either capture. Empty on
   *  a report written before they were recorded. */
  settleRequests: PendingRequest[];
  /** Requests in flight beyond the ones listed. */
  settleOmitted: number;
  /** The page's origin, to tell a third-party request from its own. */
  settleOrigin?: string;
  /** The changed pixels sit inside a custom element (a tag with a hyphen):
   *  its shadow content is not in the structure snapshot, so "identical
   *  structure" proves nothing there. */
  inCustomElement: boolean;
  flags: CaptureFlag[];
  /** The captures that ran in a renderer process an earlier story used. */
  reused: FlakeSide[];
  /** `freshRenderer` is on for this run, so order dependence is already
   *  addressed; unknown (undefined) is treated as not on. */
  freshRendererOn?: boolean;
  mismatchPercent: number;
  /** Both captures had a structure and the two are the same. */
  structureIdentical: boolean;
  externals: ExternalHit[];
  textChanges: TextChange[];
  oneSided: OneSidedElement[];
  covered: NetworkCoverage;
}

/** Above this share of the frame, "identical structure" is not a stray
 *  rendering difference: something is moving (a canvas, a video, an
 *  animation), which is a different diagnosis than render drift. */
export const RENDER_DRIFT_MAX_PERCENT = 2;

/** The most selectors one `mask` suggestion carries. */
const MAX_MASKS = 5;
/** The most requests one `network.rules` suggestion carries. */
const MAX_RULES = 5;

export function classifyFlake(o: FlakeObservations): Flake {
  return (
    externalImage(o) ??
    embed(o) ??
    settleTimeout(o) ??
    orderDependence(o) ??
    asyncElement(o) ??
    textual(o) ??
    renderDrift(o) ?? {
      cause: 'unknown',
      confidence: 'low',
      evidence: {
        mismatchPercent: o.mismatchPercent,
        ...(o.settlePending.length > 0 ? { pending: o.settlePending } : {}),
        ...(o.flags.length > 0 ? { flags: o.flags } : {}),
      },
      fix: null,
    }
  );
}

/** A patch that sets `override` on this story alone. */
const storyFix = (storyId: string, override: StoryOverride): FlakeFix => ({
  stories: { [storyId]: override },
});

const hostOf = (origin: string): string => origin.replace(/^[a-z]+:\/\//, '');

// -- settle-timeout ----------------------------------------------------------

const REQUEST_LINE = /^\d+ requests? to \S+ in flight/;
const WORK_LINE = /timers?\b|animation frame|posted message|worker/;

/** The wait ended with timers, frames or messages still pending: the page
 *  keeps running on its own, so what changed may be the moment it was caught. */
const hasPendingWork = (o: FlakeObservations): boolean =>
  o.settlePending.some((l) => WORK_LINE.test(l));

/** Resource types a placeholder can stand in for. Nothing else is ever
 *  suggested for blocking: a stylesheet, script, font or API call the page
 *  needs would change what is captured. */
const PLACEHOLDER_TYPES: ReadonlySet<string> = new Set(['Image', 'Document']);

function settleTimeout(o: FlakeObservations): Flake | undefined {
  if (!o.settleTimedOut) return undefined;
  const sawRequests =
    o.settleRequests.length > 0 || o.settlePending.some((l) => REQUEST_LINE.test(l));
  if (!sawRequests) return undefined;
  // A line cut short, a summary ("14 more requests"), or requests the report
  // did not list: the evidence is partial, so whatever is named may not be
  // what the wait was stuck on.
  const incomplete =
    o.settleOmitted > 0 ||
    o.settlePending.some((l) => l.includes('…') || /^\d+ more requests/.test(l)) ||
    o.settleRequests.length === 0;

  const rules: NetworkRule[] = [];
  let unfixable = 0;
  for (const r of o.settleRequests) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    // data:, blob:, ws: and the like never reach the network policy.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    const thirdParty = o.settleOrigin !== undefined && u.origin !== o.settleOrigin;
    if (!thirdParty || !PLACEHOLDER_TYPES.has(r.type)) {
      unfixable++;
      continue;
    }
    // The whole host for that type, not the URL: a random-photo service
    // redirects to a new path every run, so the path is useless next time. The
    // type keeps the rule off the host's stylesheets and scripts.
    const match = `type:${r.type} ${u.origin}/**`;
    if (!rules.some((x) => x.match === match))
      rules.push({ match, action: 'placeholder' });
  }
  const shown = rules.slice(0, MAX_RULES);
  return {
    cause: 'settle-timeout',
    confidence: incomplete
      ? 'low'
      : shown.length > 0 && unfixable === 0
        ? 'high'
        : 'medium',
    evidence: { pending: o.settlePending, flags: o.flags },
    fix: shown.length > 0 ? storyFix(o.storyId, { network: { rules: shown } }) : null,
  };
}

// -- external-image, embed ---------------------------------------------

/** The hits of the given kinds, biggest overlap first (the selector is the
 *  tie-break, so the answer never depends on discovery order). */
function hitsOf(o: FlakeObservations, kinds: ExternalRef['kind'][]): ExternalHit[] {
  return o.externals
    .filter((h) => kinds.includes(h.ref.kind) && !o.covered.covers?.(h.ref))
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0),
    );
}

/** Another explanation sits beside the third-party resource: the match is
 *  still the best one, but less sure. */
function confidenceBeside(o: FlakeObservations): FlakeConfidence {
  return o.textChanges.length > 0 || o.oneSided.length > 0 ? 'medium' : 'high';
}

function externalImage(o: FlakeObservations): Flake | undefined {
  if (o.covered.images) return undefined;
  const hit = hitsOf(o, ['image', 'background'])[0];
  if (!hit) return undefined;
  return {
    cause: 'external-image',
    confidence: confidenceBeside(o),
    evidence: {
      selector: hit.selector,
      url: hit.ref.origin + hit.ref.path,
      host: hostOf(hit.ref.origin),
    },
    fix: storyFix(o.storyId, { network: { external: { images: 'placeholder' } } }),
  };
}

function embed(o: FlakeObservations): Flake | undefined {
  if (o.covered.frames) return undefined;
  const hit = hitsOf(o, ['frame'])[0];
  if (!hit) return undefined;
  return {
    cause: 'embed',
    confidence: confidenceBeside(o),
    evidence: {
      selector: hit.selector,
      url: hit.ref.origin + hit.ref.path,
      host: hostOf(hit.ref.origin),
    },
    fix: storyFix(o.storyId, { network: { external: { frames: 'placeholder' } } }),
  };
}

// -- order-dependence --------------------------------------------------------

function orderDependence(o: FlakeObservations): Flake | undefined {
  // With freshRenderer on, a reused renderer is Chrome refusing a new process,
  // which no setting changes; render-drift reports it.
  if (o.reused.length === 0 || o.freshRendererOn === true) return undefined;
  return {
    cause: 'order-dependence',
    confidence: 'medium',
    evidence: { reusedIn: o.reused, flags: o.flags },
    // freshRenderer has no per-story form: the project-level patch it is.
    fix: { freshRenderer: true },
  };
}

// -- 4. async-element --------------------------------------------------------

function asyncElement(o: FlakeObservations): Flake | undefined {
  if (o.oneSided.length === 0) return undefined;
  // Elements missing from both captures, one each, are content swapping
  // places, not something arriving late; waiting for either would not help.
  const sides = new Set(o.oneSided.map((e) => e.presentIn));
  if (sides.size > 1) return undefined;
  const el = [...o.oneSided].sort(
    (a, b) =>
      b.area - a.area || (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0),
  )[0]!;
  // Waiting cannot help a page that keeps running (timers, frames pending at
  // the cap), nor an element known only by its position among siblings, which
  // is a different element the next time the list grows.
  const hopeless = hasPendingWork(o) || !el.stable;
  return {
    cause: 'async-element',
    // Which side is the late one is not known: the element may be a spinner
    // that left, not content that arrived.
    confidence: hopeless ? 'low' : 'medium',
    evidence: { selector: el.selector, presentIn: el.presentIn },
    fix: hopeless ? null : storyFix(o.storyId, { waitForSelector: el.selector }),
  };
}

// -- 5. clock, 6. random-content ---------------------------------------------

function textual(o: FlakeObservations): Flake | undefined {
  if (o.textChanges.length === 0) return undefined;
  const clocks = o.textChanges.filter(
    (t) => looksLikeTime(t.before) && looksLikeTime(t.after),
  );
  const changes = clocks.length > 0 ? clocks : o.textChanges;
  const first = changes[0]!;
  const selectors = [...new Set(changes.map((t) => t.selector))].slice(0, MAX_MASKS);
  const confidence: FlakeConfidence =
    clocks.length === 0
      ? 'low'
      : clocks.length === o.textChanges.length
        ? 'high'
        : 'medium';
  return {
    cause: clocks.length > 0 ? 'clock' : 'random-content',
    confidence,
    evidence: { selector: first.selector, before: first.before, after: first.after },
    fix: storyFix(o.storyId, { mask: selectors }),
  };
}

// -- 7. render-drift ---------------------------------------------------------

function renderDrift(o: FlakeObservations): Flake | undefined {
  if (!o.structureIdentical || o.mismatchPercent > RENDER_DRIFT_MAX_PERCENT)
    return undefined;
  // "Nothing in the page changed" is only true of a page that was still: with
  // work pending at the settle cap, or the pixels inside a custom element
  // whose shadow content the structure cannot see, a jux bug is a guess.
  if (o.settleTimedOut || hasPendingWork(o) || o.inCustomElement) return undefined;
  return {
    cause: 'render-drift',
    // The renderer-reuse flag is the known reason pixels move with nothing in
    // the page changing (#153), so it makes the diagnosis certain.
    confidence: o.flags.includes('renderer-reused') ? 'high' : 'medium',
    evidence: {
      mismatchPercent: o.mismatchPercent,
      ...(o.flags.length > 0 ? { flags: o.flags } : {}),
    },
    fix: null,
  };
}
