// Manager-side registration: the panel, and the sidebar status decoration.

import React from 'react';
import { addons, types, useStorybookApi, useStorybookState } from './storybook.js';
import { Panel } from './Panel.js';

export const ADDON_ID = 'juxtapose';
export const PANEL_ID = `${ADDON_ID}/panel`;

addons.register(ADDON_ID, (api: unknown) => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: 'Visual',
    // Docs pages have nothing to capture, so keep the tab out of the way there.
    match: ({ viewMode }: { viewMode?: string }) => viewMode === 'story',
    render: ({ active }: { active?: boolean }) => <PanelHost active={active === true} />,
  });

  void api;
});

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
