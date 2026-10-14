// `network.external: 'block'` (issue #147): requests to origins other than
// the page's own fail at once, through CDP Fetch, instead of fetching bytes
// that change between runs (a random photo, a CDN) or holding the page to the
// settle cap (a broken link that answers after 20 s, issue #125).
//
// Blocked requests fail with BlockedByClient, which arrives as
// Network.loadingFailed: the settle tracker drops them like any failed
// request, an <img> becomes `complete`, and nothing is pending or flagged.
//
// Limits: requests from out-of-process iframes and workers run on sessions
// this page does not hold and are not intercepted. data:, blob:, about: and
// file: URLs have no remote origin and always pass; so does the top-level
// document, so a story URL that redirects elsewhere still loads.

import type { Page } from '../browser/page.js';
import { SettleConfigError } from './config-errors.js';

export type ExternalNetwork = 'allow' | 'block';

export interface NetworkLayer {
  network?: { external?: ExternalNetwork };
}

/** Validate a `network` value where it is declared; `where` names the place to edit. */
export function checkNetwork(
  raw: unknown,
  where: string,
): { external?: ExternalNetwork } | undefined {
  if (raw === undefined) return undefined;
  const fail = (m: string) => new SettleConfigError(`${where}: ${m}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw fail(`'network' must be an object`);
  for (const k of Object.keys(raw))
    if (k !== 'external') throw fail(`unknown network option '${k}' (expected external)`);
  const ext = (raw as { external?: unknown }).external;
  if (ext !== undefined && ext !== 'allow' && ext !== 'block')
    throw fail(`network.external must be 'allow' or 'block', got ${JSON.stringify(ext)}`);
  return ext === undefined ? {} : { external: ext };
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
  if (current?.origin === origin) return;
  current?.off();
  if (!page.on) return;
  const tree = await page.send('Page.getFrameTree').catch(() => undefined);
  const mainFrameId = tree?.frameTree?.frame?.id;
  const state: Applied = { origin, off: () => {} };
  state.off = page.on('Fetch.requestPaused', (e) => {
    const top = e.resourceType === 'Document' && e.frameId === mainFrameId;
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
