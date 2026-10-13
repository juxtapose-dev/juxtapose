import type { Browser } from '../browser/browser.js';
import { expect, test } from 'vitest';
import { captureEnv, describeEnvChange, sameEnv, type CaptureEnv } from './env.js';

const base: CaptureEnv = {
  browser: '151.0.7922.34',
  os: 'darwin-arm64',
  encoder: '8.18.3',
};

test('captureEnv reads the browser version', () => {
  const env = captureEnv({ version: () => '151.0.7922.34' } as Browser);
  expect(env.browser).toBe('151.0.7922.34');
  expect(env.os).toBe(`${process.platform}-${process.arch}`);
  expect(env.encoder).toMatch(/^\d+\.\d+/);
});

test('any differing field makes environments unequal', () => {
  expect(sameEnv(base, { ...base })).toBe(true);
  for (const field of ['browser', 'os', 'encoder'] as const) {
    expect(sameEnv(base, { ...base, [field]: 'other' })).toBe(false);
  }
});

// An unknown environment must not read as "unchanged": baselines approved
// before this field existed have none, and claiming they match the current one
// would let the first upgrade after adoption pass unexplained.
test('an unknown environment is never equal', () => {
  expect(sameEnv(undefined, base)).toBe(false);
  expect(sameEnv(base, undefined)).toBe(false);
});

test('describeEnvChange names only what moved', () => {
  expect(describeEnvChange({ ...base, encoder: '8.16.0' }, base)).toBe(
    'encoder libvips 8.16.0 -> 8.18.3',
  );
  expect(
    describeEnvChange(
      { browser: '149.0.7827.55', os: 'linux-x64', encoder: '8.16.0' },
      base,
    ),
  ).toBe(
    'browser 149.0.7827.55 -> 151.0.7922.34, os linux-x64 -> darwin-arm64, encoder libvips 8.16.0 -> 8.18.3',
  );
  expect(describeEnvChange(base, base)).toBe('');
  expect(describeEnvChange(undefined, base)).toBe('');
});
