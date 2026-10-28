// Manager-side registration: the panel, and the sidebar status decoration.

import React from 'react';
import { addons, types, useStorybookApi, useStorybookState } from './storybook.js';
import { Panel } from './Panel.js';
import { fetchAffected, fetchBundle, flushIndex, startRun } from './api.js';
import {
  applyStatuses,
  changedStatuses,
  decoratedIds,
  statusUpdate,
  type StatusUpdate,
} from './sidebar.js';
import { registerTestProvider } from './test-provider.js';
import { CaptureBatch, RenderClassifier } from './watch.js';

export const ADDON_ID = 'juxtapose';
export const PANEL_ID = `${ADDON_ID}/panel`;

/**
 * How often the sidebar re-reads the report.
 *
 * Slower than the panel's own poll: the sidebar is ambient information, and a
 * dot appearing a couple of seconds late costs nothing. The panel polls faster
 * because someone is looking directly at it.
 */
const SIDEBAR_POLL_MS = 4000;

addons.register(ADDON_ID, (api: unknown) => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Juxtapose',
    // Docs pages have nothing to capture, so keep the tab out of the way there.
    match: ({ viewMode }: { viewMode?: string }) => viewMode === 'story',
    render: ({ active }: { active?: boolean }) => <PanelHost active={active === true} />,
  });

  // The testing module's provider: the store contract on 10, the legacy one
  // on 8.6, a silent no-op where neither exists.
  registerTestProvider(api);

  startSidebarDecoration(api);
  startWatch(api);
});

/**
 * Recapture as the developer edits.
 *
 * The trigger is Storybook's own render event rather than a file watcher: HMR
 * rerenders the story, and the story knows which component file it came from.
 * Watching the filesystem would mean maintaining a second, less accurate idea
 * of which files matter.
 *
 * Everything here fails quietly. Watch mode runs behind the developer's back,
 * so a broken dev server or a missing route should leave the manual flow
 * working rather than raise anything.
 */
function startWatch(api: unknown): void {
  const channel = getChannel(api);
  if (!channel) return;

  const classifier = new RenderClassifier();
  const batch = new CaptureBatch((storyIds) => {
    void startRun(storyIds).catch(() => {});
  });

  const onStoryRendered = (storyId: string) => {
    if (!classifier.rendered()) return;
    void fetchAffected(storyId).then((ids) => batch.add(ids));
  };
  const onStoryChanged = () => classifier.navigated();
  const onIndexInvalidated = () => void flushIndex();

  channel.on('storyRendered', onStoryRendered);
  channel.on('storyChanged', onStoryChanged);
  channel.on('storyIndexInvalidated', onIndexInvalidated);

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      batch.cancel();
      channel.off('storyRendered', onStoryRendered);
      channel.off('storyChanged', onStoryChanged);
      channel.off('storyIndexInvalidated', onIndexInvalidated);
    });
  }
}

interface Channel {
  on(event: string, cb: (...args: never[]) => void): void;
  off(event: string, cb: (...args: never[]) => void): void;
}

/** The channel is how the manager hears from the preview. Absent in tests and
 *  in any host that stubs the addons API. */
function getChannel(api: unknown): Channel | null {
  // A cast, not a guard: Channel is Storybook's own type and a function
  // returning one cannot be checked at runtime beyond `typeof`, below.
  const getter = (api as { getChannel?: () => Channel }).getChannel;
  if (typeof getter !== 'function') return null;
  try {
    return getter.call(api) ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep the sidebar in sync with the latest run.
 *
 * Deliberately driven from `register` rather than from the panel: the dots are
 * the reason you would think to open the panel in the first place, so they
 * have to work whether or not it is mounted.
 */
function startSidebarDecoration(api: unknown): void {
  let decorated: string[] = [];
  let previous: StatusUpdate = {};
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    // A hidden tab has nobody to inform; skip the fetch rather than the render.
    if (typeof document !== 'undefined' && document.hidden) return;

    try {
      const bundle = await fetchBundle();
      const update = statusUpdate(bundle.report, bundle.approved, decorated);
      // Nothing to say yet — don't clear what a previous session set.
      if (Object.keys(update).length === 0) return;

      const changed = changedStatuses(update, previous);
      if (Object.keys(changed).length === 0) return;
      const ok = await applyStatuses(api, changed);
      if (!ok) {
        // The API is missing or broken; retrying every few seconds would just
        // fill the console with the same warning.
        stopped = true;
        clearInterval(timer);
        return;
      }
      decorated = decoratedIds(update);
      previous = update;
    } catch {
      // The dev server may not be up yet, or there may be no run. Both are
      // ordinary states, not errors worth surfacing.
    }
  };

  const timer = setInterval(() => void tick(), SIDEBAR_POLL_MS);
  void tick();

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      stopped = true;
      clearInterval(timer);
    });
  }
}

const PanelHost: React.FC<{ active: boolean }> = ({ active }) => {
  const api = useStorybookApi();
  const state = useStorybookState();

  return (
    <Panel
      active={active}
      storyId={state.storyId ?? null}
      onSelectStory={(storyId) => api.selectStory(storyId)}
    />
  );
};
