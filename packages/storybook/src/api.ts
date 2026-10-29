// Thin client over the review API.
//
// Kept free of React so it can be tested without a renderer, and so a Ladle or
// Histoire UI can reuse it unchanged.

// Deep import: '@juxtapose/core' reaches sharp; this file is bundled for the browser.
import {
  compareCodeUnits,
  isSubThreshold as coreIsSubThreshold,
} from '@juxtapose/core/format';
import type { RunReport, DiffResult } from '@juxtapose/core';

const API = '/jux/api';

export type { ReviewBundle as Bundle, RunProgress as Progress } from '@juxtapose/server';
import type { ReviewBundle as Bundle, RunProgress as Progress } from '@juxtapose/server';

async function checkResponse(res: Response, operation: string): Promise<void> {
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => null);
  const message =
    typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
  throw new Error(
    typeof message === 'string' ? message : `${operation} failed: ${res.status}`,
  );
}

// Bundle and Progress come from @juxtapose/server, built from the same types
// in the same release; the casts below are that claim. Errors go through
// `unknown` because a proxy or an older server can answer them.
export async function fetchBundle(): Promise<Bundle> {
  const res = await fetch(`${API}/bundle`);
  if (!res.ok) throw new Error(`bundle: ${res.status}`);
  return res.json() as Promise<Bundle>;
}

export async function fetchProgress(): Promise<Progress> {
  const res = await fetch(`${API}/progress`);
  if (!res.ok) throw new Error(`progress: ${res.status}`);
  return res.json() as Promise<Progress>;
}

export async function approveStory(storyId: string): Promise<void> {
  const res = await fetch(`${API}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jux-csrf': '1' },
    body: JSON.stringify({ storyId }),
  });
  await checkResponse(res, 'approve');
}

export async function startRun(storyIds?: string[]): Promise<void> {
  const res = await fetch(`${API}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jux-csrf': '1' },
    body: JSON.stringify(storyIds ? { storyIds } : {}),
  });
  await checkResponse(res, 'run');
}

/**
 * Which stories to recapture when this one rerenders.
 *
 * Falls back to the story itself on any failure. Watch mode is a convenience
 * running behind the developer's back — it should quietly do less rather than
 * surface an error for something nobody asked for.
 */
export async function fetchAffected(storyId: string): Promise<string[]> {
  try {
    const res = await fetch(`${API}/affected?storyId=${encodeURIComponent(storyId)}`);
    if (!res.ok) return [storyId];
    const body: unknown = await res.json();
    const ids =
      typeof body === 'object' && body !== null && 'storyIds' in body
        ? body.storyIds
        : undefined;
    return Array.isArray(ids) &&
      ids.length > 0 &&
      ids.every((id): id is string => typeof id === 'string')
      ? ids
      : [storyId];
  } catch {
    return [storyId];
  }
}

/** Tell the server its cached story index is stale. */
export async function flushIndex(): Promise<void> {
  try {
    await fetch(`${API}/flush-index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jux-csrf': '1' },
    });
  } catch {
    // Best effort: a stale index self-corrects on the next real run.
  }
}

export async function cancelRun(): Promise<void> {
  const res = await fetch(`${API}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jux-csrf': '1' },
  });
  await checkResponse(res, 'cancel');
}

export async function fetchHandoff(storyId: string): Promise<string> {
  const res = await fetch(`${API}/handoff/${encodeURIComponent(storyId)}`);
  if (!res.ok) throw new Error(`handoff: ${res.status}`);
  return res.text();
}

/**
 * Image URL, cache-busted by a version the caller bumps after a run.
 *
 * The server marks images immutable so repeated polls don't refetch them;
 * this is what makes a fresh capture actually show up.
 */
export function imageUrl(
  kind: 'current' | 'baseline' | 'diff',
  storyId: string,
  version: number | string,
): string {
  return `${API}/image/${kind}/${encodeURIComponent(storyId)}?v=${encodeURIComponent(version)}`;
}

/**
 * A failure the diff overlay cannot show.
 *
 * Pass/fail is a byte hash, but the overlay comes from pixelmatch, which
 * tolerates small colour deltas. A brand colour nudge (#2563eb -> #1d4ed8 on
 * the example Button) fails the hash yet marks zero pixels. The panel used to
 * show "0% changed" beside an Approve button for it, which presents the change
 * a reviewer most needs to see as no change at all. A dimension change is not
 * this case: it reports 100%.
 */
export function isSubThreshold(result: DiffResult | undefined): boolean {
  return result?.status === 'fail' && coreIsSubThreshold(result);
}

/** Stories needing review, in report order. */
export function needsReview(report: RunReport | null, approved: string[]): DiffResult[] {
  if (!report) return [];
  const done = new Set(approved);
  return report.results.filter(
    (r) => r.status !== 'pass' && r.status !== 'skip' && !done.has(r.storyId),
  );
}

/**
 * Next or previous story needing review, wrapping around.
 *
 * Returns null when there is nothing to move to — no failures, or the current
 * story is the only one — so the caller can leave the selection alone rather
 * than jumping somewhere surprising.
 */
export function adjacentStory(
  report: RunReport | null,
  approved: string[],
  currentStoryId: string | null,
  direction: 'next' | 'prev',
): string | null {
  const pending = needsReview(report, approved);
  if (pending.length === 0) return null;

  const index = pending.findIndex((r) => r.storyId === currentStoryId);
  // pending is non-empty (checked above), and nextIndex is reduced mod its
  // length, so neither index can miss.
  if (index === -1) return pending[0]!.storyId;
  if (pending.length === 1) return null;

  const step = direction === 'next' ? 1 : -1;
  const nextIndex = (index + step + pending.length) % pending.length;
  return pending[nextIndex]!.storyId;
}

/**
 * A story's captures in the last run: its default capture first, then each
 * variant by name. The panel's variant switcher is built from this, keyed by
 * the story Storybook has selected.
 */
export function capturesFor(
  report: RunReport | null,
  storyId: string | null,
): DiffResult[] {
  if (!report || storyId === null) return [];
  return (
    report.results
      .filter((r) => (r.baseStoryId ?? r.storyId) === storyId)
      // Default first, then variants in code-unit order.
      .sort((a, b) =>
        a.variant === undefined
          ? -1
          : b.variant === undefined
            ? 1
            : compareCodeUnits(a.variant, b.variant),
      )
  );
}

/**
 * The capture to show: the named variant, else the default capture, else the
 * first variant (a story whose default capture was not in the run).
 */
export function pickCapture(
  captures: readonly DiffResult[],
  variant: string | null,
): DiffResult | undefined {
  return (
    (variant !== null ? captures.find((r) => r.variant === variant) : undefined) ??
    captures.find((r) => r.variant === undefined) ??
    captures[0]
  );
}

/** Captures of one story that "Approve all variants" would approve. */
export function approvableCaptures(
  captures: readonly DiffResult[],
  approved: readonly string[],
): DiffResult[] {
  const done = new Set(approved);
  return captures.filter(
    (r) =>
      (r.status === 'fail' || r.status === 'new' || r.status === 'stale') &&
      !r.error &&
      (!r.unstable || r.unrechecked === true) &&
      !done.has(r.storyId),
  );
}

/** Approve each id in order, carrying on past failures; returns the ones
 *  that failed with their reasons. */
export async function approveEach(
  ids: readonly string[],
  approve: (id: string) => Promise<unknown>,
): Promise<Array<{ id: string; reason: string }>> {
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of ids) {
    try {
      await approve(id);
    } catch (err) {
      failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return failed;
}

/** `card--a__dark (server said no), card--a__mobile (…)` */
export function describeFailures(
  failed: ReadonlyArray<{ id: string; reason: string }>,
): string {
  return failed.map((f) => `${f.id} (${f.reason})`).join(', ');
}

/** Approve every id in order; the message to show when some were refused
 *  (an unstable story answers 409), or null when all went through. */
export async function approveAllPending(
  ids: readonly string[],
  approve: (id: string) => Promise<unknown>,
): Promise<string | null> {
  const failed = await approveEach(ids, approve);
  return failed.length > 0 ? `Could not approve ${describeFailures(failed)}` : null;
}
