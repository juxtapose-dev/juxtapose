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

// Deep import on purpose: '@juxtapose/core' reaches sharp and playwright
// through the capture modules, and this file is bundled for the browser.
import { formatPercent } from '@juxtapose/core/format';
import type { RunReport, DiffStatus } from '@juxtapose/core';

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

  for (const result of report?.results ?? []) {
    seen.add(result.storyId);

    // An approval since the run means the story is settled, whatever the run
    // said at the time. Showing the stale verdict would make approving feel
    // like it did nothing.
    const status = isApproved.has(result.storyId)
      ? toSidebarStatus('pass', 0)
      : toSidebarStatus(result.status, result.mismatchPercent);

    update[result.storyId] = status;
  }

  for (const id of previousIds) {
    if (!seen.has(id)) update[id] = null;
  }

  return update;
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
  const candidate = api as {
    experimental_updateStatus?: (addonId: string, update: StatusUpdate) => Promise<void>;
    updateStatus?: (addonId: string, update: StatusUpdate) => Promise<void>;
  };

  const fn = candidate?.experimental_updateStatus ?? candidate?.updateStatus;
  if (typeof fn !== 'function') {
    console.warn(
      '[juxtapose] this Storybook version exposes no status API; ' +
        'sidebar dots are disabled. The Visual panel is unaffected.',
    );
    return false;
  }

  try {
    await fn.call(candidate, ADDON_ID, update);
    return true;
  } catch (err) {
    console.warn('[juxtapose] could not update sidebar statuses:', err);
    return false;
  }
}
