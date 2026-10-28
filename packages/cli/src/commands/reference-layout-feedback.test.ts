import { expect, test } from 'vitest';
import type { ReferenceResult } from './reference.js';
import { focusedLayoutFeedback } from './reference-layout-feedback.js';

function fixture() {
  return {
    runId: 'r1',
    states: [
      {
        name: 'desktop',
        storyId: 'form--default',
        status: 'fail',
        regions: [{ id: '0123456789abcdef:1', x: 10, y: 20, width: 100, height: 49 }],
        layout: {
          status: 'measured',
          abstained: 2,
          omittedMatches: 0,
          confidenceRules: { 'paint-1': 'unique exact paint; no CSS cause' },
          matches: Array.from({ length: 3 }, (_, i) => ({
            element: { id: `field-${i}`, label: 'textbox', provenance: 'structure' },
            targetBox: { x: 10, y: 20, width: 100, height: 49 },
            currentBox: { x: 10, y: 20, width: 100, height: 36 },
            dx: 0,
            dy: 0,
            dw: 0,
            dh: -13,
            provenance: 'measured-from-pixels',
            confidenceRule: 'paint-1',
            paintedFill: { rgb: [37, 99, 235], targetCurrentEqual: true },
          })),
        },
      },
    ],
  } as unknown as ReferenceResult;
}

test('focused measurements preserve geometry, confidence and abstentions without mutating evidence', () => {
  const input = fixture();
  const original = JSON.stringify(input);
  const focused = focusedLayoutFeedback(input);
  expect(focused).toMatchObject({
    name: 'desktop',
    capture: 'form--default',
    status: 'fail',
  });
  expect(focused.layout).toEqual((input.states[0] as { layout: unknown }).layout);
  expect(focused.meaning).toContain('other states still require verification');
  expect(focused.cropRequest).toEqual({ name: 'desktop', region: '0123456789abcdef:1' });
  expect(focused.cropRegion).toEqual({ x: 10, y: 20, width: 100, height: 49 });
  expect(JSON.stringify(input)).toBe(original);
});

test('whole over-budget identities are omitted while shorter following facts survive', () => {
  const input = fixture();
  const layout = (
    input.states[0] as unknown as {
      layout: { matches: Array<{ element: { id: string } }> };
    }
  ).layout;
  layout.matches[0]!.element.id = '界'.repeat(4000);
  const output = focusedLayoutFeedback(input);
  expect(JSON.stringify(output)).not.toContain('界');
  expect(output.layout).toMatchObject({
    omittedMatches: 1,
    matches: [
      expect.objectContaining({ element: expect.objectContaining({ id: 'field-1' }) }),
      expect.objectContaining({ element: expect.objectContaining({ id: 'field-2' }) }),
    ],
  });
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(4096);
});

test('passing or missing-structure targets do not fabricate measurements', () => {
  const input = fixture();
  delete (input.states[0] as { layout?: unknown }).layout;
  expect(focusedLayoutFeedback(input).layout).toEqual({
    status: 'unavailable',
    reason: 'no-layout-evidence',
  });
  input.states[0]!.status = 'pass';
  expect(focusedLayoutFeedback(input)).toMatchObject({
    status: 'pass',
    layout: { status: 'unavailable' },
  });
  expect(focusedLayoutFeedback(input).next).toContain('do not inspect it again');
  expect(focusedLayoutFeedback(input).cropRequest).toBeUndefined();
});

test('oversized target metadata fails explicitly instead of truncating identity', () => {
  const input = fixture();
  input.states[0]!.name = '界'.repeat(4000);
  expect(() => focusedLayoutFeedback(input)).toThrow('metadata exceeds response budget');
});

test('capture errors retain a bounded reason without another ledger request', () => {
  const input = {
    runId: 'r1',
    states: [
      { name: 'desktop', storyId: 'form', status: 'error', error: 'x'.repeat(500) },
    ],
  } as unknown as ReferenceResult;
  expect(focusedLayoutFeedback(input)).toMatchObject({
    status: 'error',
    issue: 'x'.repeat(240),
    layout: { status: 'unavailable' },
  });
  expect(focusedLayoutFeedback(input).next).not.toContain('request one saved crop');
});

test('partial geometry allows a direct edit but does not prescribe guessed target styles', () => {
  const response = focusedLayoutFeedback(fixture());
  expect(response.next).toContain('propose an edit');
  expect(response.next).toContain('Treat CSS causes as hypotheses');
  expect(response.next).toContain('cannot add PNG target DOM or abstained matches');
  expect(response.next).toContain('cropRequest');
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(4096);
});

test('missing region ID does not promise a nonexistent crop or reuse an element ID', () => {
  const input = fixture();
  (input.states[0] as unknown as { regions: unknown[] }).regions = [];
  const response = focusedLayoutFeedback(input);
  expect(response.cropRequest).toBeUndefined();
  expect(response.cropRegion).toBeUndefined();
  expect(response.next).toContain('no saved crop is available');
});

test('a complete geometry fact may cross the target while later accepted facts stay retrievable', () => {
  const input = fixture();
  const layout = (
    input.states[0] as unknown as {
      layout: { matches: Array<{ element: { id: string } }>; omittedMatches: number };
    }
  ).layout;
  const original = layout.matches[0]!;
  layout.matches = Array.from({ length: 20 }, (_, i) => ({
    ...original,
    element: { ...original.element, id: `field-${i}` },
  }));
  const saved = JSON.stringify(input);
  const result = focusedLayoutFeedback(input);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(3072);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
  expect(result.layout).toMatchObject({
    omittedMatches: 20 - result.layout.matches!.length,
  });
  expect(result.layout.matches!.length).toBeLessThan(20);
  expect(JSON.stringify(input)).toBe(saved);
});

test('requested layout reuses bounded color observations without claiming correspondence', () => {
  const input = fixture();
  Object.assign(input.states[0]!, {
    visibleColors: {
      sampledPixels: 720000,
      comparedPixels: 720000,
      visibleMismatchSamples: 19431,
      pairs: [
        {
          reference: [255, 255, 255, 255],
          current: [75, 100, 116, 255],
          pixels: 5070,
          sharePercent: 26.09,
        },
        {
          reference: [48, 95, 155, 255],
          current: [255, 255, 255, 255],
          pixels: 5000,
          sharePercent: 25.73,
        },
        {
          reference: [255, 255, 255, 255],
          current: [214, 221, 228, 255],
          pixels: 900,
          sharePercent: 4.63,
        },
      ],
    },
  });
  const original = JSON.stringify(input);
  const output = focusedLayoutFeedback(input);
  expect(output.layout).toEqual((input.states[0] as { layout: unknown }).layout);
  expect(output.colorSamples).toMatchObject({
    provenance: 'measured-from-pixels',
    visibleMismatchSamples: 19431,
    pairs: [
      { reference: '#ffffff', current: '#4b6474', samples: 5070 },
      { reference: '#305f9b', current: '#ffffff', samples: 5000 },
    ],
  });
  expect(output.colorSamples!.basis).toContain(
    'not element matches or CSS substitutions',
  );
  expect(output.omittedColorPairs).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(input)).toBe(original);
});

test('missing color evidence stays missing rather than assuming unchanged paint', () => {
  expect(focusedLayoutFeedback(fixture()).colorSamples).toBeUndefined();
  expect(focusedLayoutFeedback(fixture()).omittedColorPairs).toBeUndefined();
});

test('color observations retain alpha rather than claiming opaque paint', () => {
  const input = fixture();
  Object.assign(input.states[0]!, {
    visibleColors: {
      visibleMismatchSamples: 40,
      pairs: [{ reference: [48, 95, 155, 128], current: [0, 0, 0, 0], pixels: 40 }],
    },
  });
  expect(focusedLayoutFeedback(input).colorSamples?.pairs).toEqual([
    { reference: '#305f9b80', current: '#00000000', samples: 40 },
  ]);
});

test('color observations never evict geometry near the response limit', () => {
  let sawBudgetOmission = false;
  for (let length = 1400; length <= 3000; length += 64) {
    const input = fixture();
    const layout = (
      input.states[0] as unknown as {
        layout: { matches: Array<{ element: { id: string } }> };
      }
    ).layout;
    layout.matches = layout.matches.slice(0, 1);
    layout.matches[0]!.element.id = 'x'.repeat(length);
    const without = focusedLayoutFeedback(input);
    Object.assign(input.states[0]!, {
      visibleColors: {
        visibleMismatchSamples: 40,
        pairs: [
          { reference: [48, 95, 155, 255], current: [255, 255, 255, 255], pixels: 40 },
        ],
      },
    });
    const withColors = focusedLayoutFeedback(input);
    expect(withColors.layout).toEqual(without.layout);
    expect(Buffer.byteLength(JSON.stringify(withColors))).toBeLessThanOrEqual(4096);
    if (
      !withColors.colorSamples &&
      'matches' in withColors.layout &&
      withColors.layout.matches.length
    )
      sawBudgetOmission = true;
  }
  expect(sawBudgetOmission).toBe(true);
});
