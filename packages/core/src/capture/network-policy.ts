// `network.external: 'block'` (issue #147): requests to origins other than
// the page's own fail at once, through CDP Fetch, instead of fetching bytes
// that change between runs (a random photo, a CDN) or holding the page to the
// settle cap (a broken link that answers after 20 s, issue #125).
//
// Blocked requests fail with BlockedByClient, which arrives as
// Network.loadingFailed: the settle tracker drops them like any failed
// request, an <img> becomes `complete`, and nothing is pending or flagged.
//
// Limits: WebSockets are not intercepted, and neither is anything running on
// a session this page does not hold (an out-of-process iframe; measured:
// headless-shell ran a cross-site iframe in-process, and dedicated-worker
// fetches were blocked, but a real Chrome with site isolation may differ).
// data:, blob:, about: and file: URLs have no remote origin and always pass; so does the top-level
// document, so a story URL that redirects elsewhere still loads.

import type { Page } from '../browser/page.js';
import {
  NetworkSchema,
  type ExternalNetwork,
  type NetworkParams,
} from '../config/schema.js';
import { validate } from '../config/validate.js';

export type { ExternalNetwork };

export interface NetworkLayer {
  network?: NetworkParams;
}

/** Validate a `network` value where it is declared; `where` names the place to edit. */
export function checkNetwork(raw: unknown, where: string): NetworkParams | undefined {
  if (raw === undefined) return undefined;
  const { external } = validate<NetworkParams>(NetworkSchema, raw, where);
  return external === undefined ? {} : { external };
}

/** call > story > project, default 'allow'. */
export function resolveExternal(
  project: NetworkLayer | undefined,
  story: NetworkLayer | undefined,
  call: NetworkLayer | undefined,
): ExternalNetwork {
  return (
    call?.network?.external ??
    story?.network?.external ??
    project?.network?.external ??
    'allow'
  );
}

/** Whether `url` is a remote request to a different origin than `origin`. */
export function isExternal(url: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.origin !== origin;
}

interface Applied {
  origin: string;
  off: () => void;
}
const applied = new WeakMap<Page, Applied>();

/**
 * Make the page's request policy match `mode` for the origin of `baseUrl`.
 * Called before every navigation; a page keeps its policy until the next call,
 * so a pooled page never carries one capture's block into the next.
 */
export async function applyNetworkPolicy(
  page: Page,
  mode: ExternalNetwork,
  baseUrl: string,
): Promise<void> {
  const current = applied.get(page);
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = 'null';
  }
  if (mode === 'allow') {
    if (!current) return;
    applied.delete(page);
    current.off();
    await page.send('Fetch.disable').catch(() => {});
    return;
  }
  if (current) {
    // In place, never off() then on(): a request paused in between would
    // never be answered and would hang the page.
    current.origin = origin;
    return;
  }
  if (!page.on) return;
  const tree = await page.send('Page.getFrameTree').catch(() => undefined);
  const mainFrameId = tree?.frameTree?.frame?.id;
  const state: Applied = { origin, off: () => {} };
  state.off = page.on('Fetch.requestPaused', (e) => {
    const top = e.resourceType === 'Document' && e.frameId === mainFrameId;
    // The page's own origin is the committed main document's: a top-level
    // redirect (127.0.0.1 -> localhost) moves it, and the new document's own
    // CSS, scripts and images must not count as external.
    if (top) state.origin = originOf(e.request.url) ?? state.origin;
    const block = !top && isExternal(e.request.url, state.origin);
    const done = block
      ? page.send('Fetch.failRequest', {
          requestId: e.requestId,
          errorReason: 'BlockedByClient',
        })
      : page.send('Fetch.continueRequest', { requestId: e.requestId });
    done.catch(() => {});
  });
  applied.set(page, state);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}
