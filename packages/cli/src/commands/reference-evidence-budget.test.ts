import { expect, test } from 'vitest';
import {
  evidenceBytes,
  fitsFocusedEvidence,
  FOCUSED_MAX_BYTES,
  FOCUSED_TARGET_BYTES,
} from './reference-evidence-budget.js';

test('the soft target admits a complete fact once, not an unlimited tail', () => {
  const initial = { facts: ['a'.repeat(2800)] };
  const complete = { facts: [...initial.facts, 'b'.repeat(500)] };
  expect(evidenceBytes(initial)).toBeLessThan(FOCUSED_TARGET_BYTES);
  expect(evidenceBytes(complete)).toBeGreaterThan(FOCUSED_TARGET_BYTES);
  expect(fitsFocusedEvidence(initial, complete)).toBe(true);
  expect(fitsFocusedEvidence(complete, { facts: [...complete.facts, 'later'] })).toBe(
    false,
  );
  expect(complete.facts[1]).toBe('b'.repeat(500));
});

test('oversized facts are omitted whole and metadata has a finite ceiling', () => {
  const initial = { facts: ['a'] };
  expect(
    fitsFocusedEvidence(initial, { facts: ['a', 'b'.repeat(FOCUSED_MAX_BYTES)] }),
  ).toBe(false);
  expect(fitsFocusedEvidence(initial, { facts: ['a', 'shorter subsequent fact'] })).toBe(
    true,
  );
});
