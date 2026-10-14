import { describe, it, expect } from 'vitest';
import {
  chromeArgs,
  deterministicLaunchOptions,
  DETERMINISTIC_CHROMIUM_ARGS,
  PARITY_CHROMIUM_ARGS,
} from './flags.js';
import { SPIKE_ARGS } from './__fixtures__/spike-args.js';

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

  it('disables partial raster', () => {
    // A partial re-raster clips to the invalidated rect, and an antialiased
    // edge on that clip rasters differently: pixels that depend on repaint
    // timing (issue #120). page.test.ts reproduces it without this flag.
    expect(deterministicLaunchOptions().args).toContain('--disable-partial-raster');
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

describe('chromeArgs', () => {
  it('carries playwright-core 1.62.0 switches verbatim, then ours, then the caller', () => {
    const args = chromeArgs({ userDataDir: '/u', args: ['--foo'] });
    // The byte-identity spike ran with exactly this set (pre-flight: 56/56
    // identical, same order); a feature flag that changes raster output would
    // break every baseline, so the list is pinned.
    expect(args.slice(0, PARITY_CHROMIUM_ARGS.length)).toEqual([...PARITY_CHROMIUM_ARGS]);
    expect(PARITY_CHROMIUM_ARGS).toContain('--enable-features=CDPScreenshotNewSurface');
    expect(PARITY_CHROMIUM_ARGS).toContain('--disable-back-forward-cache');
    expect(PARITY_CHROMIUM_ARGS.find((a) => a.startsWith('--disable-features='))).toMatch(
      /PaintHolding/,
    );
    expect(args).toContain('--enable-unsafe-swiftshader');
    expect(args).toContain('--headless');
    expect(args).toContain(
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    );
    expect(args).toContain('--no-sandbox');
    for (const a of DETERMINISTIC_CHROMIUM_ARGS) expect(args).toContain(a);
    expect(args.indexOf('--foo')).toBeGreaterThan(
      args.indexOf('--force-device-scale-factor=1'),
    );
    expect(args.slice(-3)).toEqual([
      '--user-data-dir=/u',
      '--remote-debugging-pipe',
      '--no-startup-window',
    ]);
    expect(args).toHaveLength(57 + 1);
  });
});

describe('chromeArgs byte parity', () => {
  it('equals the spike-proven 56-arg list exactly, in content and order, plus --disable-partial-raster', () => {
    // Fixture generated from the spike's args.mjs (launchArgs('/U', 'pipe')).
    // Any drift in flags or order fails here before it can fail a baseline.
    // The one deliberate addition is --disable-partial-raster (issue #120):
    // it changes no bytes of a single full raster, only stops a repaint's
    // clipped re-raster from showing, and the examples captured
    // byte-identical with it.
    const args = chromeArgs({ userDataDir: '/U' });
    expect(args.filter((a) => a !== '--disable-partial-raster')).toEqual(SPIKE_ARGS);
    expect(args.indexOf('--disable-partial-raster')).toBe(
      args.indexOf('--force-color-profile=srgb', PARITY_CHROMIUM_ARGS.length) + 1,
    );
    expect(SPIKE_ARGS).toHaveLength(56);
  });
});
