import { describe, expect, it } from 'vitest';
import { BUILTIN_DEVICES, defaultOrientation, resolveDevices } from './devices.js';
import { CHROME_VERSION } from './pins.js';

const CHROME_PIN_MAJOR = CHROME_VERSION.split('.')[0];

describe('device registry', () => {
  it('has the aliases', () => {
    const r = resolveDevices();
    expect(r.get('mobile')).toEqual(r.get('iphone-15'));
    expect(r.get('tablet')).toEqual(r.get('ipad'));
    expect(r.get('desktop')).toEqual({
      width: 1280,
      height: 800,
      mobile: false,
      touch: false,
    });
  });
  it('names the pinned Chrome major in Android UAs', () => {
    expect(resolveDevices().get('pixel-8')!.userAgent).toContain(
      `Chrome/${CHROME_PIN_MAJOR}.0.0.0`,
    );
  });
  it('lets a user device extend and replace built-ins', () => {
    const r = resolveDevices({
      mobile: { extends: 'pixel-8' },
      kiosk: { width: 1080, height: 1920 },
    });
    expect(r.get('mobile')).toEqual(r.get('pixel-8'));
    expect(r.get('kiosk')).toMatchObject({
      width: 1080,
      height: 1920,
      mobile: false,
      touch: false,
    });
  });
  it('rejects cycles and unknown parents with the chain', () => {
    expect(() => resolveDevices({ a: { extends: 'b' }, b: { extends: 'a' } })).toThrow(
      'a -> b -> a',
    );
    expect(() => resolveDevices({ a: { extends: 'nope' } })).toThrow("'nope'");
  });
  it('rejects a user device without a size', () => {
    expect(() => resolveDevices({ a: { mobile: true } })).toThrow(/'a'.*width/);
  });
  it('keys are kebab-case and every built-in is listed in its default orientation', () => {
    for (const [k, d] of Object.entries(BUILTIN_DEVICES)) {
      expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(defaultOrientation(d)).toBe(d.mobile ? 'portrait' : 'landscape');
    }
  });
});
