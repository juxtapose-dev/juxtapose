import { expect, test } from 'vitest';
import {
  appendFocusedPaint,
  type PaintImageEvidence,
  type ReferencePaintDetail,
} from './reference-paint.js';
import { focusedLayoutFeedback } from './reference-layout-feedback.js';
import type { ReferenceResult } from './reference.js';

function image(role: 'target' | 'current', ys = [415, 251, 333]): PaintImageEvidence {
  return {
    status: 'measured',
    frameHash: role,
    width: 1000,
    height: 720,
    omittedComponents: 0,
    abstainedComponents: 0,
    providerFailures: 0,
    regions: ys.map((y, i) => ({
      id: `${role}-${i}`,
      box: { x: 767, y, width: 84, height: 32 },
      fill: role === 'target' ? [48, 95, 155] : [75, 100, 116],
      solidArea: 2253,
      cropHash: role,
      ...(role === 'target'
        ? { text: { full: 'Manage', score: 95 }, textStatus: 'observed' as const }
        : { elementText: 'Manage' }),
    })),
  };
}

function paint(): ReferencePaintDetail {
  return { target: image('target'), current: image('current', [377, 237, 307]) };
}

function fixture(): ReferenceResult {
  return {
    runId: 'r1',
    states: [
      {
        name: 'desktop',
        storyId: 'team-active',
        status: 'fail',
        regions: [{ id: '0123456789abcdef:1', x: 767, y: 377, width: 84, height: 83 }],
        layout: {
          status: 'measured',
          abstained: 8,
          omittedMatches: 0,
          confidenceRules: { 'paint-1': 'exact paint; unique; geometry only, not CSS' },
          matches: [-8, -8, -8, -44].map((dy, i) => ({
            element: {
              label: `current element ${i}`,
              path: 'html>body>main>section>' + 'div:nth-of-type(1)>'.repeat(5),
              provenance: 'structure',
            },
            targetBox: { x: 129, y: 155 + i * 100, width: 742, height: 70 },
            currentBox: { x: 129, y: 155 + i * 100 + dy, width: 742, height: 70 },
            paintedFill: { rgb: [255, 255, 255], targetCurrentEqual: true },
            dx: 0,
            dy,
            dw: 0,
            dh: 0,
            provenance: 'measured-from-pixels',
            confidenceRule: 'paint-1',
          })),
          paint: paint(),
        },
      },
    ],
  } as unknown as ReferenceResult;
}

test('preview paths leave room for independent repeated positions without evicting geometry', () => {
  const input = fixture(),
    saved = JSON.stringify(input),
    output = focusedLayoutFeedback(input);
  expect(output.layout).toMatchObject({
    matches: Array.from({ length: 4 }, () => expect.anything()),
    abstained: 8,
    omittedMatches: 0,
  });
  expect(output.layout.matches?.every((m) => !m.element.path)).toBe(true);
  expect(output.meaning).toContain('not unique selectors');
  expect(output.paint?.target[0]).toMatchObject({
    rgb: '#305f9b',
    textInside: 'Manage',
    count: 3,
    boxes: [
      [767, 251, 84, 32],
      [767, 333, 84, 32],
      [767, 415, 84, 32],
    ],
    omittedBoxes: 0,
  });
  expect(output.paint?.current[0]).toMatchObject({
    rgb: '#4b6474',
    elementText: 'Manage',
    count: 3,
    boxes: [
      [767, 237, 84, 32],
      [767, 307, 84, 32],
      [767, 377, 84, 32],
    ],
    omittedBoxes: 0,
  });
  expect(output.paint?.meaning).toContain('No target/current identity');
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(3072);
  expect(JSON.stringify(input)).toBe(saved);
});

test('repeated observations keep deterministic positions and explicit omitted-box counts', () => {
  const evidence = paint();
  evidence.target = image('target', [500, 251, 333, 600, 415]);
  const original = JSON.stringify(evidence);
  const a = appendFocusedPaint({ next: 'Use facts.' }, evidence);
  if (evidence.target.status !== 'measured' || evidence.current.status !== 'measured')
    throw Error('fixture');
  evidence.target.regions.reverse();
  evidence.current.regions.reverse();
  const b = appendFocusedPaint({ next: 'Use facts.' }, evidence);
  expect(a).toEqual(b);
  expect(a.paint?.target[0]).toMatchObject({
    count: 5,
    omittedBoxes: 2,
    box: [767, 251, 84, 32],
    boxes: [
      [767, 251, 84, 32],
      [767, 333, 84, 32],
      [767, 415, 84, 32],
    ],
  });
  expect(a.paint?.omitted).toEqual([0, 0]);
  evidence.target.regions.reverse();
  evidence.current.regions.reverse();
  expect(JSON.stringify(evidence)).toBe(original);
});

test('same-label components of different sizes do not collapse into one inventory', () => {
  const evidence = paint();
  if (evidence.target.status !== 'measured') throw Error('fixture');
  evidence.target.regions[0]!.box.width = 90;
  const result = appendFocusedPaint({ next: 'Use facts.' }, evidence);
  expect(result.paint?.target).toHaveLength(2);
  expect(result.paint?.target.map((r) => r.count).sort()).toEqual([1, 2]);
});

test('missing OCR or overlong labels do not fabricate target text or paired identity', () => {
  const evidence = paint();
  if (evidence.target.status !== 'measured') throw Error('fixture');
  for (const region of evidence.target.regions)
    region.text = { full: 'x'.repeat(41), score: 95 };
  expect(appendFocusedPaint({ next: 'Use facts.' }, evidence).paint?.target).toEqual([]);
  evidence.target = { status: 'unavailable', reason: 'provider-unavailable' };
  const result = appendFocusedPaint({ next: 'Use facts.' }, evidence);
  expect(result.paint).toMatchObject({ target: [], unavailable: ['target'] });
  expect(result.paint?.current[0]?.elementText).toBe('Manage');
});

test('a path-only current identity is retained rather than erased', () => {
  const input = fixture();
  const state = input.states[0] as unknown as {
    layout: { matches: Array<{ element: Record<string, string> }> };
  };
  state.layout.matches = [state.layout.matches[0]!];
  state.layout.matches[0]!.element = { path: 'html>body>main', provenance: 'structure' };
  expect(focusedLayoutFeedback(input).layout.matches?.[0]?.element.path).toBe(
    'html>body>main',
  );
});

test('optional repeated positions shrink before dropping a color group at the byte boundary', () => {
  let boundarySeen = false;
  for (let length = 10; length <= 800; length += 10) {
    const input = fixture();
    input.states[0]!.name = 'n'.repeat(length);
    const packet = focusedLayoutFeedback(input);
    if (!packet.paint?.target.length || !packet.paint.current.length) continue;
    const groups = [packet.paint.target[0]!, packet.paint.current[0]!];
    if (!groups.some((g) => (g.omittedBoxes ?? 0) > 0)) continue;
    boundarySeen = true;
    expect(groups.map((g) => g.rgb)).toEqual(['#305f9b', '#4b6474']);
    expect(groups.every((g) => g.count === g.boxes!.length + g.omittedBoxes!)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(3072);
    break;
  }
  expect(boundarySeen).toBe(true);
});
