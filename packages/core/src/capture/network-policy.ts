// `network` (issues #147, #177): what the page may request, decided through CDP
// Fetch before a request leaves the browser, instead of fetching bytes that
// change between runs (a random photo, a CDN) or holding the page to the
// settle cap (a broken link that answers after 20 s, issue #125).
//
// Each request gets, in order: the first matching `network.rules` entry, for
// any URL; else, for a request to an origin other than the page's own, the
// `network.external` entry for its resource type (images, frames, media) or
// its `default`. See network-rules.ts for the decision.
//
// Blocked requests fail with BlockedByClient (Network.loadingFailed);
// placeholders are answered with Fetch.fulfillRequest (Network.loadingFinished).
// Either way the settle tracker drops the request at once: nothing is pending
// or flagged, an <img> becomes `complete`.
//
// Limits: WebSockets are not intercepted, and neither is anything running on
// a session this page does not hold (an out-of-process iframe; measured:
// headless-shell ran a cross-site iframe in-process, and dedicated-worker
// fetches were blocked, but a real Chrome with site isolation may differ).
// data: and blob: URLs never reach Fetch, so no rule or policy applies to
// them; about: and file: URLs have no remote origin and are never third-party.
// The top-level document is never decided at all, so a story URL that
// redirects elsewhere still loads. Service-worker fetches bypass the policy
// (issue #191). `images` covers what Chrome classifies as Image; an image
// fetched with fetch() or XHR is Fetch/XHR and falls to `default`.

import type { Page } from '../browser/page.js';
import {
  NetworkSchema,
  type ExternalNetwork,
  type NetworkParams,
} from '../config/schema.js';
import { validate } from '../config/validate.js';
import { checkRulePlaceholders, decide, isActive } from './network-rules.js';
import type { NetworkPolicy } from './network-rules.js';
import { IMAGE_PLACEHOLDER_PNG, FRAME_PLACEHOLDER_HTML } from './placeholders.js';

export type { ExternalNetwork };

export interface NetworkLayer {
  network?: NetworkParams;
}

/** Validate a `network` value where it is declared; `where` names the place to edit. */
export function checkNetwork(raw: unknown, where: string): NetworkParams | undefined {
  if (raw === undefined) return undefined;
  const network = validate<NetworkParams>(NetworkSchema, raw, where);
  checkRulePlaceholders(network.rules, where);
  return {
    ...(network.external !== undefined ? { external: network.external } : {}),
    ...(network.rules !== undefined ? { rules: network.rules } : {}),
  };
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
  policy: NetworkPolicy;
  off: () => void;
}
const applied = new WeakMap<Page, Applied>();

/**
 * Make the page's request policy match `policy` for the origin of `baseUrl`.
 * Called before every navigation; a page keeps its policy until the next call,
 * so a pooled page never carries one capture's block into the next.
 */
export async function applyNetworkPolicy(
  page: Page,
  policy: NetworkPolicy,
  baseUrl: string,
): Promise<void> {
  const current = applied.get(page);
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = 'null';
  }
  if (!isActive(policy)) {
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
    current.policy = policy;
    return;
  }
  if (!page.on) return;
  const tree = await page.send('Page.getFrameTree').catch(() => undefined);
  const mainFrameId = tree?.frameTree?.frame?.id;
  const state: Applied = { origin, policy, off: () => {} };
  state.off = page.on('Fetch.requestPaused', (e) => {
    const top = e.resourceType === 'Document' && e.frameId === mainFrameId;
    // The page's own origin is the committed main document's: a top-level
    // redirect (127.0.0.1 -> localhost) moves it, and the new document's own
    // CSS, scripts and images must not count as external.
    if (top) state.origin = originOf(e.request.url) ?? state.origin;
    const verdict = top
      ? 'allow'
      : decide(state.policy, {
          url: e.request.url,
          resourceType: e.resourceType,
          external: isExternal(e.request.url, state.origin),
          subframeDocument: e.resourceType === 'Document',
        });
    const id = e.requestId;
    const origin = requestOrigin(e.request.headers);
    const done =
      verdict === 'allow'
        ? page.send('Fetch.continueRequest', { requestId: id })
        : verdict === 'block'
          ? page.send('Fetch.failRequest', {
              requestId: id,
              errorReason: 'BlockedByClient',
            })
          : page.send('Fetch.fulfillRequest', {
              requestId: id,
              responseCode: 200,
              responseHeaders:
                verdict === 'placeholder-image'
                  ? [
                      { name: 'Content-Type', value: 'image/png' },
                      // A credentialed CORS image needs the exact origin and
                      // Allow-Credentials; `*` fails it.
                      ...(origin
                        ? [
                            { name: 'Access-Control-Allow-Origin', value: origin },
                            { name: 'Access-Control-Allow-Credentials', value: 'true' },
                            { name: 'Vary', value: 'Origin' },
                          ]
                        : [{ name: 'Access-Control-Allow-Origin', value: '*' }]),
                      { name: 'Cache-Control', value: 'no-store' },
                    ]
                  : [
                      { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                      { name: 'Cache-Control', value: 'no-store' },
                    ],
              body: Buffer.from(
                verdict === 'placeholder-image'
                  ? IMAGE_PLACEHOLDER_PNG
                  : FRAME_PLACEHOLDER_HTML,
                verdict === 'placeholder-image' ? 'base64' : 'utf8',
              ).toString('base64'),
            });
    done.catch(() => {});
  });
  applied.set(page, state);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
}

function requestOrigin(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'origin');
  return key && headers[key] && headers[key] !== 'null' ? headers[key] : undefined;
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}
