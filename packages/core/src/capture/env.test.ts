import type { Browser } from '../browser/browser.js';
import { expect, test } from 'vitest';
import {
  captureEnv,
  describeEnvChange,
  emulationChange,
  encoderChange,
  sameEnv,
  type CaptureEnv,
} from './env.js';
import { CAPTURE_ENCODER } from './encoder.js';

const base: CaptureEnv = {
  browser: '151.0.7922.34',
  os: 'darwin-arm64',
  encoder: CAPTURE_ENCODER,
};

test('captureEnv reads the browser version', () => {
  const env = captureEnv({ version: () => '151.0.7922.34' } as Browser);
  expect(env.browser).toBe('151.0.7922.34');
  expect(env.os).toBe(`${process.platform}-${process.arch}`);
  expect(env.encoder).toBe('chrome-webp-lossless');
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
    "encoder libvips 8.16.0 (sharp) -> Chrome's lossless WebP",
  );
  expect(
    describeEnvChange(
      { browser: '149.0.7827.55', os: 'linux-x64', encoder: '8.16.0' },
      base,
    ),
  ).toBe(
    "browser 149.0.7827.55 -> 151.0.7922.34, os linux-x64 -> darwin-arm64, encoder libvips 8.16.0 (sharp) -> Chrome's lossless WebP",
  );
  expect(describeEnvChange(base, base)).toBe('');
  expect(describeEnvChange(undefined, base)).toBe('');
});

// A baseline approved before Chrome encoded the WebP can never match: the run
// must say "re-approve", not report every story as a regression.
test('encoderChange flags entries from another encoder, including unrecorded ones', () => {
  expect(encoderChange({ env: base })).toBeUndefined();
  expect(encoderChange({ env: { ...base, encoder: '8.17.3' } })).toBe('8.17.3');
  expect(encoderChange({})).toBe('unrecorded');
  expect(encoderChange(undefined)).toBeUndefined();
});

// A story captured on another device cannot match its baseline; the run says
// so instead of calling it a regression. Absent reads as the implicit default.
test('emulationChange compares fingerprints, absent meaning the default device', () => {
  expect(emulationChange({}, undefined)).toBeUndefined();
  expect(emulationChange(undefined, 'portrait|m1t1|ua:ab')).toBeUndefined();
  expect(emulationChange({ emulation: 'portrait|x' }, 'portrait|x')).toBeUndefined();
  expect(emulationChange({}, 'portrait|m1t1|ua:ab')).toEqual({
    from: 'default',
    to: 'portrait|m1t1|ua:ab',
  });
  expect(emulationChange({ emulation: 'portrait|x' }, undefined)).toEqual({
    from: 'portrait|x',
    to: 'default',
  });
});
