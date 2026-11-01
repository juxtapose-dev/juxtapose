import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('builds one self-contained licensed IIFE without a React runtime', () => {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../../scripts/build-react-components.mjs', import.meta.url))],
    { stdio: 'pipe' },
  );
  const dir = new URL('../../dist/components/', import.meta.url);
  const source = readFileSync(new URL('react-browser.bundle.js', dir), 'utf8');
  const meta = JSON.parse(
    readFileSync(new URL('react-browser-build.json', dir), 'utf8'),
  ) as { bytes: number; reactRuntimeBytes: number };
  expect(meta.reactRuntimeBytes).toBe(0);
  expect(meta.bytes).toBeLessThan(128 * 1024);
  expect(source).toContain('__juxReactComponents');
  expect(source).toContain('Permission is hereby granted');
  expect(source).not.toContain('useSyncExternalStore');
  expect(readFileSync(new URL('react-browser-NOTICE.txt', dir), 'utf8')).toContain(
    'Copyright 2024-present Aiden Bai',
  );
});
