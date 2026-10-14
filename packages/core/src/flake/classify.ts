// Why did two captures of one story differ, and what config change fixes it?
//
// Pure: it reads observations (analyze.ts derives them from two captures) and
// returns a verdict. The checks run in a fixed order and the first confident
// match wins, because the causes overlap: a request still pending at the settle
// cap also leaves text half-rendered, and an image from a random-photo service
// also shows up as a "changed region". The order puts the most specific, most
// directly actionable evidence first.

import type {
  CaptureFlag,
  ExternalRef,
  Flake,
  FlakeConfidence,
  FlakeFix,
  FlakeSide,
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
}

/** Which third-party requests the story's network config already answers. A
 *  covered type cannot be the source of a difference, and suggesting the same
 *  setting again would send the reader in a circle. */
export interface NetworkCoverage {
  images: boolean;
  frames: boolean;
}

export interface FlakeObservations {
  storyId: string;
  /** What each capture's settle wait was still waiting on at its cap. */
  settlePending: string[];
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
    settleTimeout(o) ??
    externalImage(o) ??
    embed(o) ??
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

// -- 1. settle-timeout -------------------------------------------------------

const REQUEST_LINE = /^\d+ requests? to (\S+) in flight \((\w+)\)$/;
const IMAGE_LINE = /^\d+ images? still loading: (.+)$/;

/** A pending description reduced to a request a rule can name. */
interface PendingRequest {
  match: string;
  placeholder: boolean;
}

/** The descriptions are for people (`describePending`), so this reads them
 *  back: a request to a path with a resource type, or the image list. Anything
 *  else pending (a timer, fonts) is not a request and yields nothing. */
function pendingRequests(pending: string[]): PendingRequest[] {
  const out: PendingRequest[] = [];
  const add = (url: string, placeholder: boolean) => {
    // A display URL is cut at 100 characters with an ellipsis; a rule built
    // from half a URL would match nothing.
    if (url.endsWith('…') || /[*\s]/.test(url)) return;
    // The query varies between requests and a path rule matches without it.
    const match = url.split('?')[0]!;
    if (match === '' || out.some((r) => r.match === match)) return;
    out.push({ match, placeholder });
  };
  for (const line of pending) {
    const req = REQUEST_LINE.exec(line);
    if (req) {
      const type = req[2]!;
      add(req[1]!, type === 'Image' || type === 'Document');
      continue;
    }
    const imgs = IMAGE_LINE.exec(line);
    if (imgs) for (const u of imgs[1]!.split(', ')) add(u, true);
  }
  return out.slice(0, MAX_RULES);
}

function settleTimeout(o: FlakeObservations): Flake | undefined {
  const requests = pendingRequests(o.settlePending);
  if (requests.length === 0) return undefined;
  const rules: NetworkRule[] = requests.map((r) => ({
    match: r.match,
    action: r.placeholder ? 'placeholder' : 'block',
  }));
  return {
    cause: 'settle-timeout',
    confidence: 'high',
    evidence: { pending: o.settlePending, flags: o.flags },
    fix: storyFix(o.storyId, { network: { rules } }),
  };
}

// -- 2. external-image, 3. embed ---------------------------------------------

/** The hits of the given kinds, biggest overlap first (the selector is the
 *  tie-break, so the answer never depends on discovery order). */
function hitsOf(o: FlakeObservations, kinds: ExternalRef['kind'][]): ExternalHit[] {
  return o.externals
    .filter((h) => kinds.includes(h.ref.kind))
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
  return {
    cause: 'async-element',
    // Which side is the late one is not known: the element may be a spinner
    // that left, not content that arrived.
    confidence: 'medium',
    evidence: { selector: el.selector, presentIn: el.presentIn },
    fix: storyFix(o.storyId, { waitForSelector: el.selector }),
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
