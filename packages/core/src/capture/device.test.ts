import { describe, expect, it } from 'vitest';
import { resolveDevices } from '../browser/devices.js';
import { emulationFingerprint, resolveDevice } from './device.js';

const D = { width: 1280, height: 800 };
const r = resolveDevices();

describe('resolveDevice', () => {
  it('no device, no orientation is today', () => {
    expect(resolveDevice({}, r, D)).toEqual({
      viewport: { width: 1280, height: 800 },
    });
    expect(
      resolveDevice({ viewport: { width: 375, height: 812 } }, r, D).emulation,
    ).toBeUndefined();
  });
  it('mobile is portrait iphone-15', () => {
    const x = resolveDevice({ device: 'mobile' }, r, D);
    expect(x.viewport).toEqual({ width: 393, height: 852 });
    expect(x.emulation).toMatchObject({
      mobile: true,
      touch: true,
      orientation: 'portrait',
      angle: 0,
    });
  });
  it('landscape rotates a phone to angle 90, desktop to angle 0', () => {
    expect(
      resolveDevice({ device: 'mobile', orientation: 'landscape' }, r, D),
    ).toMatchObject({
      viewport: { width: 852, height: 393 },
      emulation: { orientation: 'landscape', angle: 90 },
    });
    expect(
      resolveDevice({ device: 'desktop', orientation: 'portrait' }, r, D),
    ).toMatchObject({
      viewport: { width: 800, height: 1280 },
      emulation: { orientation: 'portrait', angle: 0 },
    });
  });
  it('explicit viewport keeps device emulation; orientation follows its aspect', () => {
    expect(
      resolveDevice({ device: 'pixel-8', viewport: { width: 412, height: 600 } }, r, D),
    ).toMatchObject({
      viewport: { width: 412, height: 600 },
      emulation: { mobile: true, orientation: 'portrait' },
    });
  });
  it('orientation alone rotates the fallback and records emulation', () => {
    const x = resolveDevice({ orientation: 'portrait' }, r, D);
    expect(x.viewport).toEqual({ width: 800, height: 1280 });
    expect(x.emulation).toMatchObject({
      mobile: false,
      touch: false,
      orientation: 'portrait',
    });
    expect(resolveDevice({ orientation: 'landscape' }, r, D).fingerprint).toBeDefined();
  });
  it('params.device wins over the project default', () => {
    expect(resolveDevice({ device: 'tablet' }, r, D, 'mobile').device).toBe('tablet');
    expect(resolveDevice({}, r, D, 'mobile').viewport).toEqual({
      width: 393,
      height: 852,
    });
  });
  it('unknown device names the closest keys', () => {
    expect(() => resolveDevice({ device: 'iphone15' }, r, D)).toThrow(
      /^unknown device 'iphone15'; did you mean iphone-15/,
    );
    expect(() => resolveDevice({ device: 'zzzzzzzzzzzz' }, r, D)).toThrow(
      /^unknown device 'zzzzzzzzzzzz'$/,
    );
  });
});

describe('emulationFingerprint', () => {
  it('encodes orientation, flags and UA hash, not the device name', () => {
    expect(
      emulationFingerprint({
        mobile: false,
        touch: false,
        orientation: 'landscape',
        angle: 0,
      }),
    ).toBe('landscape|m0t0|ua:none');
    expect(
      emulationFingerprint({
        mobile: true,
        touch: true,
        orientation: 'portrait',
        angle: 0,
        userAgent: 'x',
      }),
    ).toMatch(/^portrait\|m1t1\|ua:[0-9a-f]{8}$/);
  });

  // The name is recorded separately (`device`); an alias renamed to its
  // target emulates the same thing and must not read as an emulation change.
  it('an alias and its target share a fingerprint; UA and orientation do not', () => {
    const fp = (p: Parameters<typeof resolveDevice>[0]) =>
      resolveDevice(p, r, D).fingerprint;
    expect(fp({ device: 'mobile' })).toBe(fp({ device: 'iphone-15' }));
    expect(fp({ device: 'pixel-8' })).not.toBe(fp({ device: 'iphone-15' }));
    expect(fp({ device: 'iphone-15', orientation: 'landscape' })).not.toBe(
      fp({ device: 'iphone-15' }),
    );
  });
});
