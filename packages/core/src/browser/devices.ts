// packages/core/src/browser/devices.ts
//
// Built-in device registry. Sizes are CSS px in each device's listed
// (default) orientation: phones and tablets portrait, desktop landscape.
// There is no device scale factor on purpose: captures are always 1x, so a
// preset emulates behaviour (layout mode, touch, UA) and not pixel density.
//
// Sizes and UA shapes follow the device descriptor list in Playwright
// (https://github.com/microsoft/playwright, packages/playwright-core/src/
// server/deviceDescriptorsSource.json), Copyright (c) Microsoft Corporation,
// Apache License 2.0, updated for current devices. Android UAs name the
// pinned Chrome major from pins.ts, so a Chrome bump moves them with it.

import { CHROME_VERSION } from './pins.js';
import type { DeviceDescriptor, Orientation } from './types.js';

export interface UserDeviceSpec extends Partial<DeviceDescriptor> {
  extends?: string;
}

export type DeviceRegistry = ReadonlyMap<string, DeviceDescriptor>;

const CHROME_MAJOR = CHROME_VERSION.split('.')[0];

function ios(
  kind: 'iPhone' | 'iPad',
  osVersion: string,
  width: number,
  height: number,
): DeviceDescriptor {
  const os = osVersion.replace('.', '_');
  const platform =
    kind === 'iPhone' ? `iPhone; CPU iPhone OS ${os}` : `iPad; CPU OS ${os}`;
  return {
    width,
    height,
    mobile: true,
    touch: true,
    userAgent:
      `Mozilla/5.0 (${platform} like Mac OS X) AppleWebKit/605.1.15 ` +
      `(KHTML, like Gecko) Version/${osVersion} Mobile/15E148 Safari/604.1`,
  };
}

function android(
  model: string,
  androidVersion: string,
  width: number,
  height: number,
  form: 'phone' | 'tablet',
): DeviceDescriptor {
  const phone = form === 'phone';
  return {
    width,
    height,
    mobile: true,
    touch: true,
    userAgent:
      `Mozilla/5.0 (Linux; Android ${androidVersion}; ${model}) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 ${phone ? 'Mobile ' : ''}Safari/537.36`,
    userAgentMetadata: {
      platform: 'Android',
      platformVersion: `${androidVersion}.0.0`,
      architecture: '',
      model,
      mobile: phone,
    },
  };
}

const IPHONE_15 = ios('iPhone', '17.5', 393, 852);
const IPAD = ios('iPad', '17.5', 810, 1080);

export const BUILTIN_DEVICES: Readonly<Record<string, DeviceDescriptor>> = {
  'iphone-se': ios('iPhone', '17.5', 375, 667),
  'iphone-15': IPHONE_15,
  'iphone-15-pro-max': ios('iPhone', '17.5', 430, 932),
  'iphone-16': ios('iPhone', '18.0', 393, 852),
  'iphone-16-pro-max': ios('iPhone', '18.0', 440, 956),
  'pixel-7': android('Pixel 7', '14', 412, 915, 'phone'),
  'pixel-8': android('Pixel 8', '14', 412, 915, 'phone'),
  'pixel-8-pro': android('Pixel 8 Pro', '14', 448, 998, 'phone'),
  'galaxy-s24': android('SM-S921B', '14', 360, 780, 'phone'),
  'galaxy-a55': android('SM-A556B', '14', 360, 780, 'phone'),
  ipad: IPAD,
  'ipad-mini': ios('iPad', '17.5', 744, 1133),
  'ipad-pro-13': ios('iPad', '17.5', 1032, 1376),
  'galaxy-tab-s9': android('SM-X710', '14', 800, 1280, 'tablet'),
  mobile: IPHONE_15,
  tablet: IPAD,
  desktop: { width: 1280, height: 800, mobile: false, touch: false },
};

/** The listed shape: taller than wide is portrait, anything else landscape. */
export function defaultOrientation(d: { width: number; height: number }): Orientation {
  return d.height > d.width ? 'portrait' : 'landscape';
}

/**
 * Built-ins overlaid with the project's devices. A user device may `extends`
 * a built-in or another user device; one named like a built-in replaces it
 * (and `extends` its own name reaches the built-in it replaces).
 */
export function resolveDevices(
  user: Record<string, UserDeviceSpec> = {},
): DeviceRegistry {
  const out = new Map<string, DeviceDescriptor>(Object.entries(BUILTIN_DEVICES));
  const resolved = new Map<string, DeviceDescriptor>();

  const resolve = (name: string, chain: string[]): DeviceDescriptor => {
    const done = resolved.get(name);
    if (done) return done;
    const { extends: parent, ...own } = user[name]!;
    let base: Partial<DeviceDescriptor> = { mobile: false, touch: false };
    if (parent !== undefined) {
      const path = [...chain, name, parent];
      if (parent !== name && chain.includes(parent)) {
        throw new Error(`device cycle: ${path.join(' -> ')}`);
      }
      const inherited =
        parent !== name && user[parent]
          ? resolve(parent, [...chain, name])
          : BUILTIN_DEVICES[parent];
      if (!inherited) {
        throw new Error(
          `device '${name}' extends unknown device '${parent}' (${path.join(' -> ')})`,
        );
      }
      base = inherited;
    }
    const merged = { ...base, ...own };
    if (typeof merged.width !== 'number' || typeof merged.height !== 'number') {
      throw new Error(
        `device '${name}' needs a width and height (set them or use extends)`,
      );
    }
    const device = merged as DeviceDescriptor;
    resolved.set(name, device);
    return device;
  };

  for (const name of Object.keys(user)) out.set(name, resolve(name, []));
  return out;
}
