// The null platform: an explicit list of URLs, no workbench (issue #11).
//
// Everything a workbench adapter contributes — enumeration, a render signal,
// componentPath — is absent here, which is exactly what the Platform seam was
// designed to allow: settling falls entirely to core's generic pipeline (DOM
// quiescence, fonts, images, animation freeze, paint barrier), and affected
// analysis sees an empty componentPath and falls back to capturing everything.
//
// Lives in core rather than its own adapter package because it has no
// knowledge of any workbench and `jux snap` must always have it.

import type { Page } from 'playwright';
import type { Platform } from '../platform.js';
import type { StoryManifest, UrlEntry } from '../types.js';

export function createUrlPlatform(urls: UrlEntry[]): Platform {
  // Ids are baseline keys. A Map would silently keep the last duplicate and
  // two pages would share one baseline, so reject them up front.
  const byId = new Map<string, UrlEntry>();
  for (const u of urls) {
    if (!u.id) throw new Error('jux: url entry has an empty id');
    // file:, javascript:, data: would let whoever controls the config (a fork
    // PR in CI) publish local file contents in the image and structure sidecar.
    // It also turns the typo 'localhost:3000/x' (scheme "localhost:") into an
    // error instead of a confusing navigation failure.
    if (/^[a-z][a-z0-9+.-]*:/i.test(u.url) && !/^https?:/i.test(u.url)) {
      throw new Error(`jux: url '${u.url}' for id '${u.id}' must be http(s)`);
    }
    if (byId.has(u.id)) throw new Error(`jux: duplicate url id '${u.id}'`);
    byId.set(u.id, u);
  }

  const resolve = (id: string, baseUrl: string): string => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`jux: no url with id '${id}'`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(entry.url)) return entry.url;
    if (!/^https?:/i.test(baseUrl)) {
      throw new Error(`jux: relative url '${entry.url}' needs --origin`);
    }
    return new URL(entry.url, baseUrl).toString();
  };

  return {
    name: 'urls',
    async detect() {
      return false;
    },
    async enumerate(): Promise<StoryManifest[]> {
      return urls.map((u) => ({
        storyId: u.id,
        title: u.id,
        name: u.id,
        componentPath: '',
        params: u.params ?? {},
      }));
    },
    async showStory(page: Page, storyId: string, baseUrl: string) {
      await page.goto(resolve(storyId, baseUrl), { waitUntil: 'load' });
    },
    previewUrl() {
      return 'about:blank';
    },
    storyUrl(baseUrl: string, storyId: string) {
      return resolve(storyId, baseUrl);
    },
    async settle() {
      // No platform render signal. Core's generic settle runs after this.
    },
    configDirs: [],
    storyFileGlobs: [],
  };
}
