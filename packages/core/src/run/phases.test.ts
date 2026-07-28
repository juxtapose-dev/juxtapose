import { expect, test } from 'vitest';
import { formatPhases, phases } from './phases.js';

test('time records the phase and returns the value', async () => {
  const p = phases();
  const out = await p.time('capture', async () => 'snap');
  expect(out).toBe('snap');
  expect(p.timings.capture).toBeGreaterThanOrEqual(0);
});

// A phase that threw still cost the time it burned, and a run that failed
// slowly is exactly when the breakdown is worth having.
test('a throwing phase is still timed', async () => {
  const p = phases();
  await expect(
    p.time('capture', async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(p.timings.capture).toBeDefined();
});

test('repeated phases accumulate', () => {
  const p = phases();
  p.add('diff', 100);
  p.add('diff', 50);
  expect(p.timings.diff).toBe(150);
});

test('formatPhases reads in execution order and scales units', () => {
  const p = phases();
  p.add('enumerate', 12);
  p.add('capture', 48200);
  p.add('diff', 810);
  p.count('diff', 7);
  expect(formatPhases(p)).toBe('enumerate 12ms | capture 48.2s | diff(7) 810ms');
});

test('sub-millisecond phases are dropped as noise', () => {
  const p = phases();
  p.add('enumerate', 0);
  p.add('capture', 5);
  expect(formatPhases(p)).toBe('capture 5ms');
});
