// HTTP surface over a ReviewSource.
//
// Hand-rolled rather than pulling in a framework: there are ten routes, none
// of them need middleware, and the addon has to mount this inside Storybook's
// own Vite dev server where an extra HTTP stack would just be in the way.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ImageKind, ReviewSource } from './types.js';

/** Mounted under this prefix so it cannot collide with workbench routes. */
export const API_PREFIX = '/jux/api';

const IMAGE_KINDS = new Set<ImageKind>(['current', 'baseline', 'diff']);

export interface Handler {
  (req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

/**
 * Returns a handler that resolves true when it handled the request.
 *
 * The boolean matters for the middleware case: when mounted inside a dev
 * server, anything not ours has to fall through to the next handler rather
 * than 404.
 */
export function createRouter(source: ReviewSource): Handler {
  return async function handle(req, res) {
    const url = req.url ?? '/';
    if (!url.startsWith(API_PREFIX)) return false;

    const [path, query = ''] = splitOnce(url.slice(API_PREFIX.length), '?');
    const method = req.method ?? 'GET';

    try {
      await route(source, method, path, query, req, res);
    } catch (err) {
      // A failure here is a bug in the tool, not in the user's stories, so
      // surface it rather than silently returning an empty report.
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}

async function route(
  source: ReviewSource,
  method: string,
  path: string,
  query: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (method === 'GET' && path === '/bundle') {
    return json(res, 200, await source.bundle());
  }

  if (method === 'GET' && path === '/progress') {
    return json(res, 200, await source.progress());
  }

  if (method === 'GET' && path === '/stories') {
    return json(res, 200, { stories: await source.stories() });
  }

  // /image/{kind}/{storyId} — storyId may contain slashes on some platforms,
  // so take everything after the kind rather than splitting into fixed parts.
  const image = /^\/image\/([^/]+)\/(.+)$/.exec(path);
  if (method === 'GET' && image) {
    // Both groups are non-optional, so a match always fills them.
    const kind = image[1]! as ImageKind;
    if (!IMAGE_KINDS.has(kind)) return json(res, 400, { error: 'unknown image kind' });

    const bytes = await source.image(kind, decodeURIComponent(image[2]!));
    if (!bytes) return json(res, 404, { error: 'no such image' });

    res.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': bytes.length,
      // Images are content-addressed by the ?v= the client appends, so they
      // can be cached hard; without this the panel refetches every poll.
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(bytes);
    return;
  }

  const handoff = /^\/handoff\/(.+)$/.exec(path);
  if (method === 'GET' && handoff) {
    // Non-optional group: a match always fills it.
    const prompt = await source.handoff(decodeURIComponent(handoff[1]!));
    if (prompt === null)
      return json(res, 404, { error: 'no such story in the last run' });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(prompt);
    return;
  }

  if (method === 'POST' && path === '/approve') {
    const body = await readJson<{ storyId?: string }>(req);
    if (!body?.storyId) return json(res, 400, { error: 'storyId required' });
    await source.approve(body.storyId);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && path === '/run') {
    const body = await readJson<{ storyIds?: string[] }>(req);
    // Deliberately not awaited: a run takes seconds and the client polls
    // /progress. Holding the request open would just time out.
    void source.run(body?.storyIds).catch(() => {});
    return json(res, 202, { started: true });
  }

  if (method === 'POST' && path === '/cancel') {
    await source.cancel();
    return json(res, 200, { ok: true });
  }

  // GET rather than POST: it is a pure question, and the answer is cacheable
  // per story — which matters because it is asked on every rerender.
  if (method === 'GET' && path === '/affected') {
    const storyId = new URLSearchParams(query).get('storyId');
    if (!storyId) return json(res, 400, { error: 'storyId required' });
    return json(res, 200, { storyIds: await source.affected(storyId) });
  }

  if (method === 'POST' && path === '/flush-index') {
    await source.flushIndex();
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: `no route for ${method} ${path}` });
}

/** `split` with a limit keeps the tail; `String.split('?')[1]` drops anything
 *  after a second '?', which a story id could legitimately contain. */
function splitOnce(value: string, sep: string): [string, string?] {
  const at = value.indexOf(sep);
  return at === -1 ? [value] : [value.slice(0, at), value.slice(at + 1)];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // A review API has no business accepting large bodies; refuse rather
    // than buffering whatever arrives.
    if (size > 1_000_000) return null;
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}
