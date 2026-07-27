// Thin client over the review API.
//
// Kept free of React so it can be tested without a renderer, and so a Ladle or
// Histoire UI can reuse it unchanged.

import type { RunReport, DiffResult } from '@juxtapose/core';

const API = '/jux/api';

export interface Bundle {
  report: RunReport | null;
  approved: string[];
  running: boolean;
}

export interface Progress {
  running: boolean;
  done: number;
  total: number;
  storyId: string | null;
}

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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storyId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `approve failed: ${res.status}`);
  }
}

export async function startRun(storyIds?: string[]): Promise<void> {
  await fetch(`${API}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(storyIds ? { storyIds } : {}),
  });
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
    const body = (await res.json()) as { storyIds?: string[] };
    return body.storyIds?.length ? body.storyIds : [storyId];
  } catch {
    return [storyId];
  }
}

/** Tell the server its cached story index is stale. */
export async function flushIndex(): Promise<void> {
  try {
    await fetch(`${API}/flush-index`, { method: 'POST' });
  } catch {
    // Best effort: a stale index self-corrects on the next real run.
  }
}

export async function cancelRun(): Promise<void> {
  await fetch(`${API}/cancel`, { method: 'POST' });
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
  version: number,
): string {
  return `${API}/image/${kind}/${encodeURIComponent(storyId)}?v=${version}`;
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
  if (index === -1) return pending[0].storyId;
  if (pending.length === 1) return null;

  const step = direction === 'next' ? 1 : -1;
  const nextIndex = (index + step + pending.length) % pending.length;
  return pending[nextIndex].storyId;
}
