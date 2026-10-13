// Per-story status dots in Storybook's own sidebar.
//
// The panel deliberately has no story list of its own — Storybook's sidebar is
// right there, and duplicating it would be a worse version of something the
// host already does well. This is the other half of that decision: augment the
// sidebar rather than compete with it.
//
// Everything here is a pure function over a RunReport. The messy part —
// Storybook's status API is `experimental_*` and has moved between versions —
// is isolated in `applyStatuses` at the bottom.

// Deep import on purpose: '@juxtapose/core' reaches sharp and the browser driver
// through the capture modules, and this file is bundled for the browser.
import { formatPercent } from '@juxtapose/core/format';
import type { DiffResult, RunReport, DiffStatus } from '@juxtapose/core';

/** Storybook's status vocabulary. Ours has to map onto these five. */
export type SbStatusValue = 'pending' | 'success' | 'error' | 'warn' | 'unknown';

export interface SbStatus {
  status: SbStatusValue;
  title: string;
  description: string;
}

/**
 * `null` clears a story's status.
 *
 * This is why the map includes entries we want *removed* rather than simply
 * omitting them: Storybook merges updates, so an omitted id keeps whatever it
 * had. See `statusUpdate` for why that matters.
 */
export type StatusUpdate = Record<string, SbStatus | null>;

const ADDON_ID = 'juxtapose';

/**
 * Map one story's result onto a sidebar status.
 *
 * `new` and `stale` are both `warn` rather than `error` deliberately: neither
 * means the component is wrong. A new story has nothing to compare against,
 * and a stale one may well be pixel-identical — what is in question is whether
 * its baseline is still trustworthy.
 */
export function toSidebarStatus(
  status: DiffStatus,
  mismatchPercent: number,
): SbStatus | null {
  switch (status) {
    case 'pass':
      return { status: 'success', title: 'juxtapose', description: 'baseline matches' };
    case 'fail':
      return {
        status: 'error',
        title: 'juxtapose',
        description: `${formatPercent(mismatchPercent)} changed`,
      };
    case 'new':
      return { status: 'warn', title: 'juxtapose', description: 'no baseline yet' };
    case 'stale':
      return {
        status: 'warn',
        title: 'juxtapose',
        description: 'baseline from a non-ancestor commit',
      };
    case 'skip':
      // Not captured by choice. A dot here would imply we know something about
      // the story's appearance, and we do not.
      return null;
  }
}

/**
 * Build the full update for a run, including clears.
 *
 * `previousIds` is what we set last time. Any of those missing from the new
 * report gets an explicit `null`, because Storybook merges status updates
 * rather than replacing them — without the clears, a story that was failing
 * and then dropped out of the run (filtered by affected-analysis, renamed,
 * deleted) keeps its red dot forever. A stale dot is worse than no dot: it
 * asserts something false about current state.
 */
export function statusUpdate(
  report: RunReport | null,
  approved: readonly string[],
  previousIds: readonly string[],
): StatusUpdate {
  const update: StatusUpdate = {};
  const seen = new Set<string>();
  const isApproved = new Set(approved);

  // Storybook's status API is keyed by the real story id, so a story's
  // variants roll up into its one dot: the worst of them.
  const byStory = new Map<string, Array<{ status: DiffStatus; r: DiffResult }>>();
  for (const result of report?.results ?? []) {
    const id = result.baseStoryId ?? result.storyId;
    seen.add(id);
    // An approval since the run means the capture is settled, whatever the run
    // said at the time. Showing the stale verdict would make approving feel
    // like it did nothing.
    const status = isApproved.has(result.storyId) ? 'pass' : result.status;
    const list = byStory.get(id) ?? [];
    list.push({ status, r: result });
    byStory.set(id, list);
  }

  for (const [id, captures] of byStory) {
    const worst = worstCapture(captures);
    if (!worst) {
      update[id] = null;
      continue;
    }
    const status = toSidebarStatus(
      worst.status,
      worst.status === 'pass' ? 0 : worst.r.mismatchPercent,
    );
    // Name the variant that decided the dot, so a red story whose default
    // capture passes doesn't read as a mistake.
    update[id] =
      status && worst.status !== 'pass' && worst.r.variant !== undefined
        ? { ...status, description: `${worst.r.variant}: ${status.description}` }
        : status;
  }

  for (const id of previousIds) {
    if (!seen.has(id)) update[id] = null;
  }

  return update;
}

/** fail, then new, then stale, then pass. `skip` never decides a dot. */
const SEVERITY: Record<DiffStatus, number> = {
  fail: 4,
  new: 3,
  stale: 2,
  pass: 1,
  skip: 0,
};

/** The capture whose status a story's dot shows; undefined when every
 *  capture was skipped. Exported for the rollup test. */
export function worstCapture<T extends { status: DiffStatus }>(
  captures: readonly T[],
): T | undefined {
  let worst: T | undefined;
  for (const c of captures) {
    if (c.status === 'skip') continue;
    if (!worst || SEVERITY[c.status] > SEVERITY[worst.status]) worst = c;
  }
  return worst;
}

/** Story ids carrying a status, so the next update knows what to clear. */
export function decoratedIds(update: StatusUpdate): string[] {
  return Object.keys(update).filter((id) => update[id] !== null);
}

/**
 * Push statuses into Storybook, tolerating an API that keeps moving.
 *
 * `experimental_updateStatus(addonId, update)` is what Storybook 8 exposes;
 * the name and shape have changed across majors and the `experimental_` prefix
 * is an explicit warning that they will change again. A missing method must
 * degrade to a console warning: losing the dots is a cosmetic regression,
 * whereas throwing here would take down the whole manager and with it the
 * panel, which is the part that actually matters.
 */
export async function applyStatuses(
  api: unknown,
  update: StatusUpdate,
): Promise<boolean> {
  const host = typeof api === 'object' && api !== null ? api : undefined;
  const fn =
    (host && 'experimental_updateStatus' in host
      ? host.experimental_updateStatus
      : undefined) ?? (host && 'updateStatus' in host ? host.updateStatus : undefined);
  if (typeof fn !== 'function') {
    console.warn(
      '[juxtapose] this Storybook version exposes no status API; ' +
        'sidebar dots are disabled. The Visual panel is unaffected.',
    );
    return false;
  }

  try {
    await fn.call(host, ADDON_ID, update);
    return true;
  } catch (err) {
    console.warn('[juxtapose] could not update sidebar statuses:', err);
    return false;
  }
}
