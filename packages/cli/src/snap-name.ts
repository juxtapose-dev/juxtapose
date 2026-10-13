// File-safe snap names. A name becomes a path under .juxtapose/snaps/, so it
// must not be able to traverse out of it.
export function snapName(url: string, as?: string): string {
  const source = as ?? url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'snap';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Slugs for the urls of one `--as-prefix` call, keyed by url.
 *
 * Path-based, so "before" on one dev-server port and "after" on another still
 * pair: a restarted server or a Vite/Storybook port fallback is routine, and
 * keying on the port would put every page in `missing`. Within one origin the
 * slug is path + query (`index` for `/`). Across origins the host stays so
 * `a.test/x` and `b.test/x` do not collide; its port is dropped only for
 * loopback hosts, where the port is an accident of the machine rather than an
 * identity. A fragment is never part of the key.
 */
export function prefixSlugs(urls: string[]): Map<string, string> {
  const parsed = urls.map((u) => new URL(u));
  const oneOrigin = new Set(parsed.map((u) => u.origin)).size === 1;
  const slugs = new Map<string, string>();
  for (const [i, u] of parsed.entries()) {
    const path = u.pathname === '/' && !u.search ? 'index' : `${u.pathname}${u.search}`;
    const host = LOOPBACK.has(u.hostname) ? u.hostname : u.host;
    slugs.set(
      urls[i],
      snapName(
        oneOrigin ? path : `${host}/${path}`,
        oneOrigin ? path : `${host}/${path}`,
      ),
    );
  }
  return slugs;
}
