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
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(3072);
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
});
