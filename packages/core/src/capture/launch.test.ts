import { describe, it, expect } from 'vitest';
import { deterministicLaunchOptions, DETERMINISTIC_CHROMIUM_ARGS } from './launch.js';

describe('deterministicLaunchOptions', () => {
  it('disables GPU rasterization', () => {
    // The direct cause of off-by-one antialiasing jitter on rounded corners,
    // which under a byte-exact hash is a failed build rather than a rounding
    // error someone can wave through.
    const { args } = deterministicLaunchOptions();
    expect(args).toContain('--disable-gpu');
    expect(args).toContain('--disable-gpu-rasterization');
  });

  it('pins colour and text rendering to machine-independent settings', () => {
    const { args } = deterministicLaunchOptions();
    expect(args).toContain('--force-color-profile=srgb');
    expect(args).toContain('--disable-lcd-text');
    expect(args).toContain('--disable-font-subpixel-positioning');
  });

  it('pins the device scale factor', () => {
    // A baseline captured at 2x will never match one captured at 1x.
    expect(deterministicLaunchOptions().args).toContain('--force-device-scale-factor=1');
  });

  it('defaults to headless', () => {
    expect(deterministicLaunchOptions().headless).toBe(true);
  });

  it('appends caller args after the deterministic set so they can override', () => {
    const { args } = deterministicLaunchOptions({ args: ['--foo'] });
    expect(args.at(-1)).toBe('--foo');
    expect(args.length).toBe(DETERMINISTIC_CHROMIUM_ARGS.length + 1);
  });

  it('does not mutate the shared arg list between calls', () => {
    deterministicLaunchOptions({ args: ['--one'] });
    const { args } = deterministicLaunchOptions();
    expect(args).not.toContain('--one');
    expect(args.length).toBe(DETERMINISTIC_CHROMIUM_ARGS.length);
  });
});
