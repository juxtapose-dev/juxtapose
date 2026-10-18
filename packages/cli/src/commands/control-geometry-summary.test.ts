import { expect, test } from 'vitest';
import type { DiffResult } from '@juxtapose/core';
import { controlGeometrySummary } from './control-geometry-summary.js';

function failure(storyId: string, id = 'name'): DiffResult {
  return {
    storyId,
    status: 'fail',
    mismatchPixels: 1,
    mismatchPercent: 1,
    changedRegions: [],
    controlGeometry: {
      observations: [
        {
          id,
          tag: 'input',
          height: { approved: 49, current: 36 },
          provenance: 'structure',
          confidenceRule:
            'unique same DOM id or test ID, with matching tag and role in both snapshots; measured border-box size, not a CSS cause',
          suppressedResize: true,
        },
      ],
      omitted: 0,
      abstained: 0,
      incompatible: false,
    },
  };
}

test('deduplicates selected measurements and keeps explicit comparison direction', () => {
  const input = ['desktop', 'mobile', 'other'].map((id) => failure(id));
  const summary = controlGeometrySummary(input)!;
  expect(summary.items).toEqual([
    {
      element: { id: 'name' },
      dimension: 'height',
      approved: 49,
      current: 36,
      captures: 'all-failing',
    },
  ]);
  expect(summary.basis).toContain('not CSS causes');
  expect(controlGeometrySummary([...input].reverse())).toEqual(summary);
});

test('does not claim all failing captures when one lacks evidence or has an error', () => {
  const a = failure('desktop'),
    b = failure('mobile');
  b.error = 'capture failed';
  expect(controlGeometrySummary([a, b])!.items[0]!.captures).toEqual(['desktop']);
  delete a.controlGeometry!.observations[0]!.suppressedResize;
  expect(controlGeometrySummary([a, b])).toBeUndefined();
});

test('preserves differing dimensions and explicit test identities', () => {
  const a = failure('desktop'),
    b = failure('mobile');
  b.controlGeometry!.observations[0]!.height!.current = 40;
  delete b.controlGeometry!.observations[0]!.id;
  b.controlGeometry!.observations[0]!.testId = 'name';
  expect(controlGeometrySummary([a, b])!.items).toHaveLength(2);
});

test('bounds multibyte identities and capture lists without silently losing omission counts', () => {
  const data = [
    failure('a', '界'.repeat(1000)),
    ...Array.from({ length: 6 }, (_, i) => failure('capture-' + i, 'control-' + i)),
  ];
  data[1]!.controlGeometry!.omitted = 2;
  const summary = controlGeometrySummary(data)!;
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(768);
  expect(summary.items.length).toBeLessThanOrEqual(3);
  expect(summary.omittedMeasurements).toBe(7 - summary.items.length);
  expect(summary.unlistedDetailObservations).toBe(2);
  expect(summary.items.some((x) => 'id' in x.element && x.element.id.length > 100)).toBe(
    false,
  );
});

test('groups exact named-control measurements without expanding the compact budget', () => {
  const data = ['ready', 'ready-mobile', 'delayed', 'delayed-mobile'].map((key) => {
    const result = failure(key);
    result.controlGeometry!.observations = ['Ready', 'Delayed'].map((name) => ({
      tag: 'button',
      role: 'button',
      name,
      height: { approved: 45, current: 39 },
      provenance: 'structure',
      confidenceRule:
        'suppressed structural pair; unique same tag, role and name in both complete snapshots, without IDs; measured border-box size, not a CSS cause',
      suppressedResize: true,
    }));
    return result;
  });
  const result = controlGeometrySummary(data)!;
  expect(result.items).toEqual(
    ['Delayed', 'Ready'].map((name) => ({
      element: { tag: 'button', role: 'button', name },
      dimension: 'height',
      approved: 45,
      current: 39,
      captures: 'all-failing',
    })),
  );
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(768);
  expect(controlGeometrySummary([...data].reverse())).toEqual(result);
  for (const capture of data)
    capture.controlGeometry!.observations[0]!.name = '界'.repeat(500);
  const bounded = controlGeometrySummary(data)!;
  expect(bounded.items).toHaveLength(1);
  expect(bounded.omittedMeasurements).toBe(1);
  expect(JSON.stringify(bounded)).not.toContain('界');
});
