import type { StructureElement, StructureSnapshot } from '../types.js';

const CONTROLS = new Set(['input', 'textarea', 'select', 'button']);
const MAX_OBSERVATIONS = 3;
// The useful billing addition was 304 bytes. A count limit alone lets long
// application IDs overwhelm that evidence; retain whole identities or omit.
const MAX_OBSERVATION_BYTES = 1_024;
const RULE =
  'unique same DOM id or test ID, with matching tag and role in both snapshots; measured border-box size, not a CSS cause' as const;
const NAMED_RULE =
  'suppressed structural pair; unique same tag, role and name in both complete snapshots, without IDs; measured border-box size, not a CSS cause' as const;

export interface SuppressedControlResizes {
  ids: ReadonlySet<string>;
  testIds: ReadonlySet<string>;
  /** Pairs already matched and suppressed by structural fact extraction. */
  namedPairs?: ReadonlyArray<readonly [StructureElement, StructureElement]>;
}

export interface ControlGeometryObservation {
  id?: string;
  testId?: string;
  tag: string;
  role?: string;
  /** Exact saved accessible name, never a truncated selector or guessed identity. */
  name?: string;
  width?: { approved: number; current: number };
  height?: { approved: number; current: number };
  provenance: 'structure';
  confidenceRule: typeof RULE | typeof NAMED_RULE;
  /** Existing fact extraction omitted this resize as an ancestor follower. */
  suppressedResize?: true;
}

/** The billing replay changed field spacing after its textbox resize was
 * suppressed as an ancestor follower. This optional evidence keeps the
 * measured control size; it never claims that height or spacing CSS caused it.
 * IDs are counted across all elements so a duplicate on a wrapper also abstains.
 */
export function observeControlGeometry(
  approved: StructureSnapshot,
  current: StructureSnapshot,
  suppressed: SuppressedControlResizes = {
    ids: new Set(),
    testIds: new Set(),
  },
) {
  const observations: ControlGeometryObservation[] = [];
  // Identity uniqueness cannot be established when omitted elements might
  // carry the same ID. Do not turn a capture cap into a confident match.
  if (approved.truncated || current.truncated)
    return {
      observations,
      omitted: 0,
      abstained: approved.elements.filter((element) => CONTROLS.has(element.tag)).length,
      incompatible: false,
      unavailable: 'truncated-structure' as const,
    };
  if (
    approved.viewport.width !== current.viewport.width ||
    approved.viewport.height !== current.viewport.height
  )
    return { observations, omitted: 0, abstained: 0, incompatible: true };
  const key = (attribute: string, value: string) => JSON.stringify([attribute, value]);
  const index = (elements: StructureElement[]) => {
    const ids = new Map<string, StructureElement | null>();
    for (const element of elements) {
      for (const attribute of ['id', 'testId'] as const) {
        const value = element[attribute];
        if (!value) continue;
        const identity = key(attribute, value);
        ids.set(identity, ids.has(identity) ? null : element);
      }
    }
    return ids;
  };
  const a = index(approved.elements),
    b = index(current.elements);
  // Shipment's Ready/Delayed controls were already matched, but their 45→39
  // heights disappeared as ancestor followers because neither had an ID.
  // Do not reuse arbitrary structural pairs: the matcher also has a tag-only
  // fallback. Exact globally unique names only validate these suppressed pairs.
  const namedKey = (element: StructureElement) =>
    element.role?.trim() && element.name?.trim()
      ? JSON.stringify([element.tag, element.role, element.name])
      : undefined;
  const nameIndex = (elements: StructureElement[]) => {
    const names = new Map<string, StructureElement | null>();
    for (const element of elements) {
      const key = namedKey(element);
      if (key) names.set(key, names.has(key) ? null : element);
    }
    return names;
  };
  const named = new Map<StructureElement, StructureElement>();
  if (suppressed.namedPairs?.length) {
    const namesA = nameIndex(approved.elements),
      namesB = nameIndex(current.elements);
    for (const [old, now] of suppressed.namedPairs) {
      const key = namedKey(old);
      if (!key || key !== namedKey(now)) continue;
      const originalOld = namesA.get(key),
        originalNow = namesB.get(key);
      if (!originalOld || !originalNow) continue;
      // Never bypass an explicit identity, including an ID present on one side
      // only or an empty attribute. Existing ID/test-ID behavior stays separate.
      if (
        [old, now, originalOld, originalNow].some(
          (element) => element.id !== undefined || element.testId !== undefined,
        )
      )
        continue;
      named.set(originalOld, originalNow);
    }
  }
  let abstained = 0;
  for (const old of approved.elements) {
    if (!CONTROLS.has(old.tag)) continue;
    const identity = old.id
      ? key('id', old.id)
      : old.testId
        ? key('testId', old.testId)
        : undefined;
    const namedNow = !identity ? named.get(old) : undefined;
    const now = identity ? b.get(identity) : namedNow;
    if (
      (!identity && !namedNow) ||
      (identity && a.get(identity) !== old) ||
      !now ||
      (old.id && now.id && old.id !== now.id) ||
      (old.testId && now.testId && old.testId !== now.testId) ||
      old.tag !== now.tag ||
      old.role !== now.role ||
      ![old.rect.w, old.rect.h, now.rect.w, now.rect.h].every(
        (n) => Number.isFinite(n) && n > 0,
      )
    ) {
      abstained++;
      continue;
    }
    const width =
      old.rect.w !== now.rect.w
        ? { approved: old.rect.w, current: now.rect.w }
        : undefined;
    const height =
      old.rect.h !== now.rect.h
        ? { approved: old.rect.h, current: now.rect.h }
        : undefined;
    if (!width && !height) continue;
    observations.push({
      ...(namedNow
        ? { name: old.name! }
        : old.id
          ? { id: old.id }
          : { testId: old.testId! }),
      tag: old.tag,
      ...(old.role ? { role: old.role } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      provenance: 'structure',
      confidenceRule: namedNow ? NAMED_RULE : RULE,
      ...(namedNow ||
      (old.id ? suppressed.ids.has(old.id) : suppressed.testIds.has(old.testId!))
        ? { suppressedResize: true as const }
        : {}),
    });
  }
  const observationKey = (value: ControlGeometryObservation) =>
    value.name !== undefined
      ? JSON.stringify(['name', value.tag, value.role, value.name])
      : value.id
        ? key('id', value.id)
        : key('testId', value.testId!);
  observations.sort((a, b) => {
    if (Boolean(a.suppressedResize) !== Boolean(b.suppressedResize))
      return a.suppressedResize ? -1 : 1;
    const ka = observationKey(a),
      kb = observationKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const bounded: ControlGeometryObservation[] = [];
  let bytes = 2; // JSON array brackets, including the empty result.
  for (const observation of observations) {
    if (bounded.length === MAX_OBSERVATIONS) break;
    const size = Buffer.byteLength(JSON.stringify(observation), 'utf8');
    const separator = bounded.length ? 1 : 0;
    if (bytes + separator + size > MAX_OBSERVATION_BYTES) continue;
    bounded.push(observation);
    bytes += separator + size;
  }
  return {
    observations: bounded,
    omitted: observations.length - bounded.length,
    abstained,
    incompatible: false,
  };
}
