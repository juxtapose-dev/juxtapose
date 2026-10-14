// URL patterns for `settle.network.ignore` / `settle.network.require`. Its own
// module so the config validator (config/validate.ts) can check a pattern
// without importing the settle layering that itself calls the validator.

/** CDP Network.ResourceType values, for `type:` validation. */
export const RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'TextTrack',
  'XHR',
  'Fetch',
  'Prefetch',
  'EventSource',
  'WebSocket',
  'Manifest',
  'SignedExchange',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'FedCM',
  'Other',
] as const;

export interface UrlPattern {
  /** As written, for messages. */
  source: string;
  /** Canonical resource type, when the pattern has `type:`. */
  type?: string;
  /** Absent when the pattern is a type alone. */
  glob?: RegExp;
  /** A glob starting with `/` matches the URL's path, not the whole URL. */
  pathOnly: boolean;
}

/**
 * `[type:<ResourceType>] [<glob>]`, at least one of the two. In the glob `**`
 * matches anything, `*` anything but `/`, `?` one character but `/`. A glob
 * starting with `/` matches the path (`/api/feed`), anything else the whole
 * URL (`https://cdn.example.com/**`). Throws with the reason; the caller
 * prefixes where the pattern came from.
 */
export function parsePattern(source: string): UrlPattern {
  const tokens = source.trim().split(/\s+/).filter(Boolean);
  let type: string | undefined;
  let glob: string | undefined;
  for (const t of tokens) {
    if (/^type:/i.test(t)) {
      if (type !== undefined) throw new Error(`pattern '${source}' has two types`);
      const name = t.slice(5);
      const known = RESOURCE_TYPES.find((r) => r.toLowerCase() === name.toLowerCase());
      if (!known)
        throw new Error(
          `pattern '${source}': unknown resource type '${name}' (one of ${RESOURCE_TYPES.join(', ')})`,
        );
      type = known;
    } else {
      if (glob !== undefined)
        throw new Error(
          `pattern '${source}' has two URL globs; write one, or one pattern per glob`,
        );
      glob = t;
    }
  }
  if (type === undefined && glob === undefined)
    throw new Error('a pattern must not be empty');
  return {
    source,
    ...(type !== undefined ? { type } : {}),
    ...(glob !== undefined ? { glob: globToRegExp(glob) } : {}),
    pathOnly: glob?.startsWith('/') === true,
  };
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchPattern(
  p: UrlPattern,
  url: string,
  type: string | undefined,
): boolean {
  if (p.type !== undefined && p.type !== (type ?? 'Other')) return false;
  if (!p.glob) return true;
  if (!p.pathOnly) return p.glob.test(url);
  try {
    return p.glob.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
