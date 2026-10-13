// packages/core/src/browser/resolve.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  resolveChrome,
  juxCacheDir,
  chromeInstallDir,
  chromeBinaryPath,
  msPlaywrightBinaryPath,
  noBrowserMessage,
  NO_BROWSER_MESSAGE,
} from './resolve.js';
import { CHROME_PINS, CHROME_VERSION, chromePlatform } from './pins.js';

const mac = { platform: 'darwin' as const, arch: 'arm64', homedir: '/Users/u', env: {} };
const JUX_DIR = '/Users/u/Library/Caches/jux/chrome-headless-shell/151.0.7922.34';
const juxBin = `${JUX_DIR}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const juxMarker = `${JUX_DIR}/.complete`;
const PW_DIR = '/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234';
const pwBin = `${PW_DIR}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const pwMarker = `${PW_DIR}/INSTALLATION_COMPLETE`;
const have =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('chromePlatform', () => {
  it('maps node platform/arch to the CfT platform key', () => {
    expect(chromePlatform('darwin', 'arm64')).toBe('mac-arm64');
    expect(chromePlatform('darwin', 'x64')).toBe('mac-x64');
    expect(chromePlatform('linux', 'x64')).toBe('linux64');
    expect(chromePlatform('win32', 'x64')).toBe('win64');
  });
  it('names the unsupported platform and the escape hatch', () => {
    // CfT publishes no linux-arm64 build of 151.0.7922.34 (spec §Decisions 6).
    expect(() => chromePlatform('linux', 'arm64')).toThrow(/linux-arm64.*JUX_CHROME/);
  });
  it('pins every platform with a 64-hex sha256 and the CfT url', () => {
    for (const pin of Object.values(CHROME_PINS)) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.url).toBe(
        `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${pin.platform}/chrome-headless-shell-${pin.platform}.zip`,
      );
    }
  });
});

describe('paths', () => {
  it('uses the OS cache directory, overridable by JUX_CACHE_DIR', () => {
    expect(juxCacheDir(mac)).toBe('/Users/u/Library/Caches/jux');
    expect(
      juxCacheDir({ ...mac, platform: 'linux', env: { XDG_CACHE_HOME: '/x' } }),
    ).toBe('/x/jux');
    expect(juxCacheDir({ ...mac, platform: 'linux', env: {} })).toBe(
      '/Users/u/.cache/jux',
    );
    // path.join is the host's; on POSIX that yields "C:\L/jux", which is what a win32 host would not do.
    expect(
      juxCacheDir({ ...mac, platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } }),
    ).toBe(path.join('C:\\L', 'jux'));
    expect(juxCacheDir({ ...mac, env: { JUX_CACHE_DIR: '/tmp/c' } })).toBe('/tmp/c');
  });
  it('lays the install out like the zip does', () => {
    const dir = chromeInstallDir('/c', '151.0.7922.34');
    expect(dir).toBe('/c/chrome-headless-shell/151.0.7922.34');
    expect(chromeBinaryPath(dir, 'mac-arm64')).toBe(
      '/c/chrome-headless-shell/151.0.7922.34/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(chromeBinaryPath(dir, 'win64')).toBe(
      path.join(dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    );
  });
  it('knows where Playwright keeps the same build', () => {
    expect(msPlaywrightBinaryPath(mac)).toBe(pwBin);
    expect(
      msPlaywrightBinaryPath({ ...mac, env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }),
    ).toBe(
      '/pw/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
  });
});

describe('resolveChrome', () => {
  it('prefers flag, then env, then the jux cache, then ms-playwright', () => {
    const all = have('/f', '/e', juxBin, juxMarker, pwBin, pwMarker);
    expect(
      resolveChrome({ ...mac, flag: '/f', env: { JUX_CHROME: '/e' }, exists: all }),
    ).toEqual({ path: '/f', source: 'flag' });
    expect(resolveChrome({ ...mac, env: { JUX_CHROME: '/e' }, exists: all })).toEqual({
      path: '/e',
      source: 'env',
    });
    expect(
      resolveChrome({ ...mac, exists: have(juxBin, juxMarker, pwBin, pwMarker) }),
    ).toEqual({ path: juxBin, source: 'jux-cache' });
    expect(resolveChrome({ ...mac, exists: have(pwBin, pwMarker) })).toEqual({
      path: pwBin,
      source: 'ms-playwright',
    });
  });
  it('requires the install markers, not just the binary', () => {
    // A half-extracted install must not be used: the marker is written last.
    expect(resolveChrome({ ...mac, exists: have(juxBin) })).toBeNull();
    expect(resolveChrome({ ...mac, exists: have(pwBin) })).toBeNull();
  });
  it('a flag or env that points nowhere is an error, not a fallthrough', () => {
    expect(() =>
      resolveChrome({ ...mac, flag: '/nope', exists: have(juxBin, juxMarker) }),
    ).toThrow(/\/nope/);
    expect(() =>
      resolveChrome({
        ...mac,
        env: { JUX_CHROME: '/nope' },
        exists: have(juxBin, juxMarker),
      }),
    ).toThrow(/JUX_CHROME/);
  });
  it('returns null when nothing resolves, and the message names the fix and the platform', () => {
    expect(resolveChrome({ ...mac, exists: () => false })).toBeNull();
    expect(NO_BROWSER_MESSAGE).toMatch(/npx -p @juxtapose\/cli jux browser install/);
    expect(NO_BROWSER_MESSAGE).toMatch(/JUX_CHROME/);
    expect(noBrowserMessage({ ...mac, platform: 'linux', arch: 'arm64' })).toMatch(
      /linux-arm64/,
    );
    expect(noBrowserMessage(mac)).toBe(NO_BROWSER_MESSAGE);
  });
});
