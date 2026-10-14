---
'@juxtapose/storybook': patch
---

Fix the addon panel crashing in React 19 projects (`Cannot read properties of undefined (reading 'recentlyCreatedOwnerStacks')`). The manager code imported `react/jsx-runtime`, which Storybook does not provide to the manager, so it was bundled from the project's React 19 and ran against the manager's React 18. The manager now compiles with the classic JSX transform and imports only modules the manager provides.
