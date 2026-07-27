// Helper for platforms that address a story by URL.
//
// Most workbenches do: Storybook has iframe.html?id=, Ladle has ?story=. For
// those, "show me this story" is just a navigation, and there is no reason for
// each adapter to write the same three lines.
//
// Playwright's component-testing galleries are the exception that made
// `showStory` an action rather than a URL — see Platform.showStory.

import type { Page } from 'playwright';

/**
 * Build a `showStory` implementation from a URL builder.
 *
 * Note `waitUntil: 'load'` rather than `networkidle`: the platform's own
 * render signal and core's settle pipeline decide when the page is actually
 * ready. Waiting for network idle here would be both slower and less reliable
 * — a story that polls would never satisfy it.
 */
export function navigateToStory(
  storyUrl: (baseUrl: string, storyId: string) => string,
): (page: Page, storyId: string, baseUrl: string) => Promise<void> {
  return async (page, storyId, baseUrl) => {
    await page.goto(storyUrl(baseUrl, storyId), { waitUntil: 'load' });
  };
}
