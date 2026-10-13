// packages/core/src/browser/resolve.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveChrome,
  juxCacheDir,
  juxStateDir,
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
  it('pins every platform to the measured sha256 and size, at the CfT url', () => {
    const expected = {
      linux64: [
        '3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14',
        120231126,
      ],
      'mac-arm64': [
        'cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d',
        99275008,
      ],
      'mac-x64': [
        '608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea',
        103580477,
      ],
      win64: [
        '46cc69ef55ba29268ffe32dda4192a9d2165be42c3f4e923241153d519493aea',
        120106945,
      ],
    } as const;
    for (const [platform, [sha256, bytes]] of Object.entries(expected)) {
      const pin = CHROME_PINS[platform as keyof typeof CHROME_PINS];
      expect(pin.platform).toBe(platform);
      expect(pin.sha256).toBe(sha256);
      expect(pin.bytes).toBe(bytes);
      expect(pin.url).toBe(
        `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform}/chrome-headless-shell-${platform}.zip`,
      );
    }
  });
});

const win = { platform: 'win32' as const, arch: 'x64', homedir: 'C:\\Users\\u', env: {} };
const lin = { platform: 'linux' as const, arch: 'x64', homedir: '/home/u', env: {} };

describe('paths', () => {
  it('uses the OS cache directory, overridable by JUX_CACHE_DIR', () => {
    expect(juxCacheDir(mac)).toBe('/Users/u/Library/Caches/jux');
    expect(juxCacheDir({ ...lin, env: { XDG_CACHE_HOME: '/x' } })).toBe('/x/jux');
    expect(juxCacheDir(lin)).toBe('/home/u/.cache/jux');
    expect(juxCacheDir({ ...win, env: { LOCALAPPDATA: 'C:\\L' } })).toBe('C:\\L\\jux');
    expect(juxCacheDir(win)).toBe('C:\\Users\\u\\AppData\\Local\\jux');
    expect(juxCacheDir({ ...mac, env: { JUX_CACHE_DIR: '/tmp/c/../c' } })).toBe('/tmp/c');
  });
  it('keeps daemon state with the cache unless JUX_STATE_DIR moves it alone', () => {
    expect(juxStateDir(mac)).toBe('/Users/u/Library/Caches/jux');
    expect(juxStateDir({ ...mac, env: { JUX_CACHE_DIR: '/c' } })).toBe('/c');
    const both = { JUX_CACHE_DIR: '/c', JUX_STATE_DIR: '/s/../s' };
    expect(juxStateDir({ ...mac, env: both })).toBe('/s');
    expect(juxCacheDir({ ...mac, env: both })).toBe('/c');
    expect(juxStateDir({ ...mac, env: { JUX_STATE_DIR: '' } })).toBe(juxCacheDir(mac));
  });
  it('lays the install out like the zip does', () => {
    const dir = chromeInstallDir('/c', '151.0.7922.34');
    expect(dir).toBe('/c/chrome-headless-shell/151.0.7922.34');
    expect(chromeBinaryPath(dir, 'mac-arm64')).toBe(
      '/c/chrome-headless-shell/151.0.7922.34/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(chromeBinaryPath(chromeInstallDir('C:\\c'), 'win64')).toBe(
      'C:\\c\\chrome-headless-shell\\151.0.7922.34\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
    );
  });
  it('knows where Playwright keeps the same build', () => {
    expect(msPlaywrightBinaryPath(mac)).toBe(pwBin);
    expect(
      msPlaywrightBinaryPath({ ...mac, env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }),
    ).toBe(
      '/pw/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(
      msPlaywrightBinaryPath({ ...lin, env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }),
    ).toBe(
      '/pw/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
    );
    expect(msPlaywrightBinaryPath({ ...lin, env: {} })).toBe(
      '/home/u/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
    );
    expect(
      msPlaywrightBinaryPath({ ...win, env: { PLAYWRIGHT_BROWSERS_PATH: 'D:\\pw' } }),
    ).toBe(
      'D:\\pw\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
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

describe('resolveChrome details', () => {
  const winPw =
    'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234';
  const winPwBin = `${winPw}\\chrome-headless-shell-win64\\chrome-headless-shell.exe`;
  it('finds the win32 Playwright install by its INSTALLATION_COMPLETE marker', () => {
    expect(
      resolveChrome({
        ...win,
        exists: have(winPwBin, `${winPw}\\INSTALLATION_COMPLETE`),
      }),
    ).toEqual({ path: winPwBin, source: 'ms-playwright' });
    expect(resolveChrome({ ...win, exists: have(winPwBin) })).toBeNull();
  });
  it('honours PLAYWRIGHT_BROWSERS_PATH on linux, but not the "0" sentinel', () => {
    const bin =
      '/pw/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
    const marker = '/pw/chromium_headless_shell-1234/INSTALLATION_COMPLETE';
    expect(
      resolveChrome({
        ...lin,
        env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' },
        exists: have(bin, marker),
      }),
    ).toEqual({ path: bin, source: 'ms-playwright' });
    const zero =
      '0/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
    expect(
      resolveChrome({
        ...lin,
        env: { PLAYWRIGHT_BROWSERS_PATH: '0' },
        exists: have(zero, '0/chromium_headless_shell-1234/INSTALLATION_COMPLETE'),
      }),
    ).toBeNull();
  });
  it('returns null on linux-arm64 even with JUX_CHROME unset', () => {
    expect(resolveChrome({ ...lin, arch: 'arm64', exists: () => true })).toBeNull();
  });
  it('treats an empty JUX_CHROME as unset', () => {
    expect(
      resolveChrome({ ...mac, env: { JUX_CHROME: '' }, exists: have(juxBin, juxMarker) }),
    ).toEqual({ path: juxBin, source: 'jux-cache' });
  });
  it('returns resolved paths for flag and env', () => {
    expect(resolveChrome({ ...mac, flag: '/a/../f', exists: () => true })).toEqual({
      path: '/f',
      source: 'flag',
    });
    expect(
      resolveChrome({ ...mac, env: { JUX_CHROME: '/a/../e' }, exists: () => true }),
    ).toEqual({ path: '/e', source: 'env' });
  });
  it('rejects a flag or env that is a directory', () => {
    const isDirectory = (p: string) => p === '/d';
    expect(() =>
      resolveChrome({ ...mac, flag: '/d', exists: () => true, isDirectory }),
    ).toThrow(/directory/);
    expect(() =>
      resolveChrome({
        ...mac,
        env: { JUX_CHROME: '/d' },
        exists: () => true,
        isDirectory,
      }),
    ).toThrow(/JUX_CHROME.*directory/);
  });
});
