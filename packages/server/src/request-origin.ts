import type { IncomingMessage } from 'node:http';

/** A loopback-bound server must not trust arbitrary Host headers after DNS rebinding. */
export function localReviewOrigin(req: IncomingMessage): string | null {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''))
    return null;
  const host = req.headers.host;
  if (!host) return null;
  try {
    const protocol = (req.socket as { encrypted?: boolean }).encrypted
      ? 'https:'
      : 'http:';
    const url = new URL(`${protocol}//${host}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
