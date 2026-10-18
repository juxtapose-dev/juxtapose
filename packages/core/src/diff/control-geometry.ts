import type { StructureElement, StructureSnapshot } from '../types.js';

const CONTROLS = new Set(['input', 'textarea', 'select', 'button']);
const MAX_OBSERVATIONS = 3;
// The useful billing addition was 304 bytes. A count limit alone lets long
// application IDs overwhelm that evidence; retain whole identities or omit.
const MAX_OBSERVATION_BYTES = 1_024;
const RULE =
  'unique same DOM id or test ID, with matching tag and role in both snapshots; measured border-box size, not a CSS cause' as const;

export interface ControlGeometryObservation {
  id?: string;
  testId?: string;
  tag: string;
  role?: string;
  width?: { approved: number; current: number };
  height?: { approved: number; current: number };
  provenance: 'structure';
  confidenceRule: typeof RULE;
}

/** The billing replay changed field spacing after its textbox resize was
 * suppressed as an ancestor follower. This optional evidence keeps the
 * measured control size; it never claims that height or spacing CSS caused it.
 * IDs are counted across all elements so a duplicate on a wrapper also abstains.
 */
export function observeControlGeometry(
  approved: StructureSnapshot,
  current: StructureSnapshot,
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
  let abstained = 0;
  for (const old of approved.elements) {
    if (!CONTROLS.has(old.tag)) continue;
    const identity = old.id
      ? key('id', old.id)
      : old.testId
        ? key('testId', old.testId)
        : undefined;
    const now = identity ? b.get(identity) : undefined;
    if (
      !identity ||
      a.get(identity) !== old ||
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
      ...(old.id ? { id: old.id } : { testId: old.testId! }),
      tag: old.tag,
      ...(old.role ? { role: old.role } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      provenance: 'structure',
      confidenceRule: RULE,
    });
  }
  const observationKey = (value: ControlGeometryObservation) =>
    value.id ? key('id', value.id) : key('testId', value.testId!);
  observations.sort((a, b) => {
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
