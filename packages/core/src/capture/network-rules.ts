// The pure half of `network` (issues #147, #177): normalizing and layering the
// `external` forms and the URL rules, resolving them into one policy, and
// deciding an action for one request. Nothing here touches a page; the CDP
// side is network-policy.ts.

import type {
  ExternalNetwork,
  NetworkAction,
  NetworkParams,
  NetworkRule,
} from '../config/schema.js';
import { SettleConfigError } from './config-errors.js';
import { matchPattern, parsePattern, type UrlPattern } from './url-pattern.js';

/** Resource types a placeholder can stand in for. */
export const PLACEHOLDER_TYPES = ['Image', 'Document'] as const;

/** The object form of `network.external`, every field optional. */
export interface ExternalTypes {
  default?: 'allow' | 'block';
  images?: NetworkAction;
  frames?: NetworkAction;
  media?: NetworkAction;
}

/** `external` as an object: the string form means `{ default }`. */
export function externalTypes(external: ExternalNetwork | undefined): ExternalTypes {
  if (external === undefined) return {};
  return typeof external === 'string' ? { default: external } : external;
}

/** Layer `over` on `under`: the type map field by field, except that a string
 *  `over.external` means that policy for every resource type, so it replaces
 *  `default` and clears `under`'s per-type entries. `over`'s rules
 *  before `under`'s (rules are checked in order, the first match wins, and a
 *  higher layer is checked first). Absent keys stay absent. */
export function mergeNetwork(
  under: NetworkParams | undefined,
  over: NetworkParams | undefined,
): NetworkParams | undefined {
  if (!under) return over;
  if (!over) return under;
  const types: ExternalTypes =
    typeof over.external === 'string'
      ? { default: over.external }
      : { ...externalTypes(under.external), ...externalTypes(over.external) };
  const rules =
    under.rules || over.rules
      ? [...(over.rules ?? []), ...(under.rules ?? [])]
      : undefined;
  return {
    ...(under.external !== undefined || over.external !== undefined
      ? { external: types }
      : {}),
    ...(rules ? { rules } : {}),
  };
}

export interface ResolvedRule {
  pattern: UrlPattern;
  action: NetworkAction;
}

export interface NetworkPolicy {
  /** For third-party requests with no type entry. */
  default: 'allow' | 'block';
  images?: NetworkAction;
  frames?: NetworkAction;
  media?: NetworkAction;
  rules: ResolvedRule[];
}

/** The policy for one capture from its layers, lowest first (project, story,
 *  call). Assumes each layer passed checkNetwork. */
export function resolveNetwork(
  ...layers: Array<NetworkParams | undefined>
): NetworkPolicy {
  let merged: NetworkParams | undefined;
  for (const l of layers) merged = mergeNetwork(merged, l);
  const t = externalTypes(merged?.external);
  return {
    default: t.default ?? 'allow',
    ...(t.images !== undefined ? { images: t.images } : {}),
    ...(t.frames !== undefined ? { frames: t.frames } : {}),
    ...(t.media !== undefined ? { media: t.media } : {}),
    rules: (merged?.rules ?? []).map((r) => ({
      pattern: parsePattern(r.match),
      action: r.action,
    })),
  };
}

/** Whether the policy can change any request. An all-`allow` policy is
 *  inert, and the page needs no interception at all. */
export function isActive(p: NetworkPolicy): boolean {
  return (
    p.default !== 'allow' ||
    p.images === 'block' ||
    p.images === 'placeholder' ||
    p.frames === 'block' ||
    p.frames === 'placeholder' ||
    p.media === 'block' ||
    p.media === 'placeholder' ||
    p.rules.some((r) => r.action !== 'allow')
  );
}

/** The kind of stand-in a `placeholder` action serves for a resource type, or
 *  undefined when that type has none (and the action falls back to `block`). */
export function placeholderKind(
  resourceType: string | undefined,
  isSubframeDocument: boolean,
): 'image' | 'frame' | undefined {
  if (resourceType === 'Image') return 'image';
  if (resourceType === 'Document' && isSubframeDocument) return 'frame';
  return undefined;
}

export type Decision = 'allow' | 'block' | 'placeholder-image' | 'placeholder-frame';

/**
 * What to do with one request. Rules first, in order, the first match wins,
 * for any URL; then, for a third-party request only, the entry for its
 * resource type, then `default`. `placeholder` on a type with no stand-in
 * (media, and anything a rule matched by URL alone) is `block`.
 */
export function decide(
  p: NetworkPolicy,
  req: {
    url: string;
    resourceType: string | undefined;
    external: boolean;
    subframeDocument: boolean;
  },
): Decision {
  let action: NetworkAction | undefined = p.rules.find((r) =>
    matchPattern(r.pattern, req.url, req.resourceType),
  )?.action;
  if (action === undefined) {
    if (!req.external) return 'allow';
    action =
      (req.resourceType === 'Image'
        ? p.images
        : req.resourceType === 'Media'
          ? p.media
          : req.subframeDocument
            ? p.frames
            : undefined) ?? p.default;
  }
  if (action !== 'placeholder') return action;
  const kind = placeholderKind(req.resourceType, req.subframeDocument);
  return kind === 'image'
    ? 'placeholder-image'
    : kind === 'frame'
      ? 'placeholder-frame'
      : 'block';
}

/**
 * Reject a `placeholder` rule that can only match requests with no stand-in
 * (`type:Script`): it would always fall back to `block`, which is not what
 * was written. A rule by URL alone is accepted; it falls back at runtime.
 */
export function checkRulePlaceholders(
  rules: readonly NetworkRule[] | undefined,
  where: string,
): void {
  rules?.forEach((r, i) => {
    if (r.action !== 'placeholder') return;
    const type = parsePattern(r.match).type;
    if (type !== undefined && !(PLACEHOLDER_TYPES as readonly string[]).includes(type))
      throw new SettleConfigError(
        `${where}: network.rules[${i}]: 'placeholder' only applies to ${PLACEHOLDER_TYPES.join(', ')} requests, but '${r.match}' matches ${type} only. Use 'block'.`,
      );
  });
}
