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
