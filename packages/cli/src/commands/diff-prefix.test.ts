import { expect, test } from 'vitest';
import { pairByPrefix } from './diff.js';

const files = [
  'before-home.webp',
  'before-settings.webp',
  'after-home.webp',
  'before-home.structure.json.gz',
  'other.webp',
];

test('pairs snaps by slug under two prefixes and lists the unpaired', () => {
  const r = pairByPrefix(files, 'before', 'after');
  expect(r.pairs).toEqual([{ slug: 'home', a: 'before-home', b: 'after-home' }]);
  expect(r.missing).toEqual([
    { slug: 'settings', have: 'before-settings', want: 'after-settings' },
  ]);
});

test('an after-only slug is also missing, pointing at the before name', () => {
  const r = pairByPrefix(['after-x.webp'], 'before', 'after');
  expect(r.missing).toEqual([{ slug: 'x', have: 'after-x', want: 'before-x' }]);
});

test('output is sorted by slug', () => {
  const r = pairByPrefix(['b-z.webp', 'a-z.webp', 'b-a.webp', 'a-a.webp'], 'a', 'b');
  expect(r.pairs.map((p) => p.slug)).toEqual(['a', 'z']);
});

test('a prefix that is a prefix of another prefix does not cross-match', () => {
  const r = pairByPrefix(['before-x.webp', 'before2-x.webp'], 'before', 'before2');
  expect(r.pairs).toEqual([{ slug: 'x', a: 'before-x', b: 'before2-x' }]);
});

test('crop dir names cannot collide across different pairs', async () => {
  const { cropDirName } = await import('./diff.js');
  expect(cropDirName('x-vs-y', 'z')).not.toBe(cropDirName('x', 'y-vs-z'));
  expect(cropDirName('before', 'after')).toBe('before~vs~after');
});
