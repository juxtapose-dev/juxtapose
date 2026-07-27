// Manager-side registration: the panel, and the sidebar status decoration.

import React from 'react';
import { addons, types, useStorybookApi, useStorybookState } from './storybook.js';
import { Panel } from './Panel.js';
import { fetchBundle } from './api.js';
import { applyStatuses, decoratedIds, statusUpdate } from './sidebar.js';
import { registerTestProvider } from './test-provider.js';

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
    title: 'Visual',
    // Docs pages have nothing to capture, so keep the tab out of the way there.
    match: ({ viewMode }: { viewMode?: string }) => viewMode === 'story',
    render: ({ active }: { active?: boolean }) => <PanelHost active={active === true} />,
  });

  // Storybook 10 only; a silent no-op on 8 and 9, where there is no test
  // panel to appear in.
  registerTestProvider(api);

  startSidebarDecoration(api);
});

/**
 * Keep the sidebar in sync with the latest run.
 *
 * Deliberately driven from `register` rather than from the panel: the dots are
 * the reason you would think to open the panel in the first place, so they
 * have to work whether or not it is mounted.
 */
function startSidebarDecoration(api: unknown): void {
  let decorated: string[] = [];
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

      const ok = await applyStatuses(api, update);
      if (!ok) {
        // The API is missing or broken; retrying every few seconds would just
        // fill the console with the same warning.
        stopped = true;
        clearInterval(timer);
        return;
      }
      decorated = decoratedIds(update);
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
