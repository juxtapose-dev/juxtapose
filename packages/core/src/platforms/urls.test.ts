import type { Page } from '../browser/page.js';
import { expect, test, vi } from 'vitest';
import { createUrlPlatform } from './urls.js';

const p = createUrlPlatform([
  { id: 'home', url: 'http://localhost:3000/' },
  { id: 'settings', url: '/settings', params: { delay: 50 } },
]);
const target = { projectRoot: '/x' };

test('enumerates entries as stories with no componentPath', async () => {
  const stories = await p.enumerate(target);
  expect(stories.map((s) => s.storyId)).toEqual(['home', 'settings']);
  expect(stories[0]).toMatchObject({ title: 'home', name: 'home', componentPath: '' });
  expect(stories[1].params).toEqual({ delay: 50 });
});

test('is never autodetected', async () => {
  expect(await p.detect(target)).toBe(false);
});

test('absolute URLs ignore baseUrl; relative URLs resolve against it', async () => {
  const goto = vi.fn(async () => null);
  const page = { goto } as unknown as Page;
  await p.showStory(page, 'home', 'about:blank');
  await p.showStory(page, 'settings', 'http://localhost:5173');
  expect(goto.mock.calls.map((c) => c[0])).toEqual([
    'http://localhost:3000/',
    'http://localhost:5173/settings',
  ]);
});

test('a relative URL with no origin is a clear error', async () => {
  const page = { goto: vi.fn() } as unknown as Page;
  await expect(p.showStory(page, 'settings', 'about:blank')).rejects.toThrow(
    /relative url '\/settings' needs --origin/,
  );
});

test('an unknown id is a clear error', async () => {
  const page = { goto: vi.fn() } as unknown as Page;
  await expect(p.showStory(page, 'nope', 'about:blank')).rejects.toThrow(
    /no url with id 'nope'/,
  );
});

test('settle resolves immediately; core does the generic settling', async () => {
  await expect(p.settle({} as Page, {} as never)).resolves.toBeUndefined();
});

test('a duplicate id is rejected at construction', () => {
  expect(() =>
    createUrlPlatform([
      { id: 'home', url: '/a' },
      { id: 'home', url: '/b' },
    ]),
  ).toThrow(/duplicate url id 'home'/);
});

test('an empty id is rejected at construction', () => {
  expect(() => createUrlPlatform([{ id: '', url: '/a' }])).toThrow(/empty id/);
});

test.each(['file:///etc/passwd', 'javascript:alert(1)', 'localhost:3000/x'])(
  'rejects non-http(s) url %s at construction',
  (url) => {
    expect(() => createUrlPlatform([{ id: 'x', url }])).toThrow(/must be http\(s\)/);
  },
);

test('scheme check is case-insensitive', () => {
  expect(() => createUrlPlatform([{ id: 'x', url: 'HTTPS://x' }])).not.toThrow();
});

test.each([
  ' file:///etc/passwd',
  '\tfile:///etc/passwd',
  'fi\tle:///etc/passwd',
  'FILE:///x',
])('rejects parser-differential scheme %j at construction', (url) => {
  expect(() => createUrlPlatform([{ id: 'x', url }])).toThrow(/must be http\(s\)/);
});

test('protocol-relative url resolves against an https origin', async () => {
  const goto = vi.fn(async () => null);
  const q = createUrlPlatform([{ id: 'e', url: '//evil.example/x' }]);
  await q.showStory({ goto } as unknown as Page, 'e', 'https://app.test');
  expect(goto.mock.calls[0][0]).toBe('https://evil.example/x');
});

test('a relative url resolving to a non-http scheme is rejected on showStory', async () => {
  const q = createUrlPlatform([{ id: 'e', url: '/x' }]);
  const page = { goto: vi.fn() } as unknown as Page;
  await expect(q.showStory(page, 'e', 'file:///tmp/')).rejects.toThrow(/needs --origin/);
});
