import type { DiffResult } from '@juxtapose/core';

const MAX_BYTES = 768;
const MAX_ITEMS = 3;
export interface ControlMeasurement {
  element: { id: string } | { testId: string };
  dimension: 'width' | 'height';
  approved: number;
  current: number;
  captures: string[] | 'all-failing';
}

/** Experimental inline candidate, not part of the default MCP response.
 * A saved-detail request cost one round trip in the billing decision pair;
 * padding/typography controls benefited from no extra geometry. Only selected
 * ancestor-suppressed measurements enter this bounded cross-capture summary.
 */
export function controlGeometrySummary(results: DiffResult[]) {
  const failing = results.filter((r) => r.status === 'fail');
  const captureIds = new Set(failing.map((r) => r.storyId));
  const groups = new Map<
    string,
    { item: Omit<ControlMeasurement, 'captures'>; captures: Set<string> }
  >();
  let unlistedDetailObservations = 0;
  for (const result of failing) {
    if (result.error || !result.controlGeometry) continue;
    unlistedDetailObservations += result.controlGeometry.omitted;
    for (const observation of result.controlGeometry.observations) {
      if (!observation.suppressedResize) continue;
      const element = observation.id
        ? { id: observation.id }
        : observation.testId
          ? { testId: observation.testId }
          : undefined;
      if (!element) continue;
      for (const dimension of ['height', 'width'] as const) {
        const size = observation[dimension];
        if (!size || size.approved === size.current) continue;
        const item = { element, dimension, ...size };
        const key = JSON.stringify(item);
        const group = groups.get(key) ?? { item, captures: new Set<string>() };
        group.captures.add(result.storyId);
        groups.set(key, group);
      }
    }
  }
  if (!groups.size) return undefined;
  const candidates = [...groups.entries()].sort(
    ([ka, a], [kb, b]) =>
      b.captures.size - a.captures.size || (ka < kb ? -1 : ka > kb ? 1 : 0),
  );
  const items: ControlMeasurement[] = [];
  const build = () => ({
    basis: 'structure: approved→current border-box sizes; not CSS causes',
    items,
    omittedMeasurements: groups.size - items.length,
    unlistedDetailObservations,
  });
  for (const [, group] of candidates) {
    if (items.length === MAX_ITEMS) break;
    const item: ControlMeasurement = {
      ...group.item,
      captures:
        group.captures.size === captureIds.size
          ? 'all-failing'
          : [...group.captures].sort(),
    };
    items.push(item);
    if (Buffer.byteLength(JSON.stringify(build()), 'utf8') > MAX_BYTES) items.pop();
  }
  return build();
}
