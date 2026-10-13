---
'@juxtapose/storybook': patch
'@juxtapose/server': patch
---

The **Visual** test provider now registers in Storybook's testing module. On Storybook 9 and 10 the addon reads `experimental_getTestProviderStore` from `storybook/manager-api`, where Storybook exports it, instead of from the manager `api` object. On Storybook 8.5 and 8.6 the addon uses the older test provider contract, so **Run tests** runs the visual suite there too.

The review server's agent handoff now points at the baseline image in the baseline store, the same file `jux handoff` names. For a variant, that's the variant's own baseline. Before, it pointed at a run-dir path that nothing writes.
