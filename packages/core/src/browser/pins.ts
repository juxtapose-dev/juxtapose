// packages/core/src/browser/pins.ts
//
// The browser is pinned, not "latest": Chromium 149 -> 151 changed 2 of 18
// example baselines (see capture/env.ts), so moving the version is a
// deliberate PR with a migration note, never a side effect of an install.
//
// 151.0.7922.34 is the exact build playwright-core 1.62.0 ships as
// chromium-headless-shell r1234, so upgrading from the Playwright driver to
// this one changes no bytes. Verified 2026-10-13: the binary inside CfT's
// mac-arm64 zip and the one in ~/Library/Caches/ms-playwright/
// chromium_headless_shell-1234 share sha256 7687bff7cb2db075….
//
// Chrome for Testing publishes no checksums (known-good-versions-with-
// downloads.json carries only version, revision and urls), so the sha256 of
// each zip was measured from the published files and pinned here.

export const CHROME_VERSION = '151.0.7922.34';
export const MS_PLAYWRIGHT_REVISION = '1234';

export type ChromePlatform = 'linux64' | 'mac-arm64' | 'mac-x64' | 'win64';

export interface ChromePin {
  platform: ChromePlatform;
  url: string;
  sha256: string;
  bytes: number;
}

const url = (p: ChromePlatform) =>
  `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${p}/chrome-headless-shell-${p}.zip`;

export const CHROME_PINS: Record<ChromePlatform, ChromePin> = {
  linux64: {
    platform: 'linux64',
    url: url('linux64'),
    sha256: '3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14',
    bytes: 120231126,
  },
  'mac-arm64': {
    platform: 'mac-arm64',
    url: url('mac-arm64'),
    sha256: 'cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d',
    bytes: 99275008,
  },
  'mac-x64': {
    platform: 'mac-x64',
    url: url('mac-x64'),
    sha256: '608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea',
    bytes: 103580477,
  },
  win64: {
    platform: 'win64',
    url: url('win64'),
    sha256: '46cc69ef55ba29268ffe32dda4192a9d2165be42c3f4e923241153d519493aea',
    bytes: 120106945,
  },
};

/** CfT platform key for this machine. linux-arm64 has no 151.0.7922.34 build. */
export function chromePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ChromePlatform {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'win32' && arch === 'x64') return 'win64';
  const key = platform === 'linux' ? `linux-${arch}` : `${platform}-${arch}`;
  throw new Error(
    `jux: Chrome for Testing publishes no chrome-headless-shell ${CHROME_VERSION} for ${key}. ` +
      `Point JUX_CHROME at a Chromium ${CHROME_VERSION.split('.')[0]} headless shell.`,
  );
}
