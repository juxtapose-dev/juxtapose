import { expect, test } from 'vitest';
import { snapName } from './snap-name.js';

test('slugs the url', () => {
  expect(snapName('http://localhost:5173/settings/profile?tab=1')).toBe(
    'localhost-5173-settings-profile',
  );
});

test('an explicit name wins but is sanitized', () => {
  expect(snapName('http://x/', 'before')).toBe('before');
  expect(snapName('http://x/', '../../etc/passwd')).toBe('etc-passwd');
});

test('never empty, never longer than 60', () => {
  expect(snapName('about:blank', '///')).toBe('snap');
  expect(snapName(`http://x/${'a'.repeat(200)}`).length).toBeLessThanOrEqual(60);
});
