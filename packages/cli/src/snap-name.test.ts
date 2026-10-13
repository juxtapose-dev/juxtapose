import { describe, expect, test } from 'vitest';
import { prefixSlugs, snapName } from './snap-name.js';

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

describe('prefixSlugs', () => {
  test('one origin: path + query, index for /, and the port never matters', () => {
    const a = prefixSlugs([
      'http://localhost:5173/',
      'http://localhost:5173/settings?tab=x',
    ]);
    const b = prefixSlugs([
      'http://localhost:5174/',
      'http://localhost:5174/settings?tab=x',
    ]);
    expect([...a.values()]).toEqual(['index', 'settings-tab-x']);
    expect([...b.values()]).toEqual([...a.values()]);
  });

  test('hash routes keep their fragment, so a hash-routed SPA pairs and does not collide', () => {
    const s = prefixSlugs(['http://h.test/#/a', 'http://h.test/#/b']);
    expect([...s.values()]).toEqual(['a', 'b']);
  });

  test('query keeps otherwise identical paths apart', () => {
    const s = prefixSlugs(['http://h.test/ok', 'http://h.test/ok?page=2']);
    expect(new Set(s.values()).size).toBe(2);
  });

  test('several origins keep the host; loopback drops its port, others keep it', () => {
    const s = prefixSlugs(['http://localhost:3000/x', 'http://example.com:8080/x']);
    expect([...s.values()]).toEqual(['localhost-x', 'example-com-8080-x']);
  });
});
