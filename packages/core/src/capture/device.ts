import { createHash } from 'node:crypto';
import { defaultOrientation } from '../browser/devices.js';
import type { DeviceRegistry } from '../browser/devices.js';
import type {
  DeviceDescriptor,
  DeviceEmulation,
  Orientation,
  Viewport,
} from '../browser/types.js';
import type { StoryParams } from '../types.js';

export interface ResolvedDevice {
  viewport: Viewport;
  /** Undefined exactly when neither `device` nor `orientation` is set. */
  emulation?: DeviceEmulation;
  device?: string;
  fingerprint?: string;
}

export class UnknownDeviceError extends Error {
  override name = 'UnknownDeviceError';
  constructor(device: string, suggestions: string[]) {
    super(
      `unknown device '${device}'` +
        (suggestions.length > 0 ? `; did you mean ${suggestions.join(', ')}?` : ''),
    );
  }
}

// Core cannot import the CLI's suggest.ts, so a small Levenshtein lives here.
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function closestKeys(name: string, keys: Iterable<string>): string[] {
  return [...keys]
    .map((k) => ({ k, d: distance(name, k) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    .slice(0, 3)
    .map((x) => x.k);
}

function rotate(size: Viewport, to: Orientation): Viewport {
  return defaultOrientation(size) === to
    ? { width: size.width, height: size.height }
    : { width: size.height, height: size.width };
}

export function emulationFingerprint(
  device: string | undefined,
  e: DeviceEmulation,
): string {
  const ua =
    e.userAgent === undefined && e.userAgentMetadata === undefined
      ? 'none'
      : createHash('sha256')
          .update((e.userAgent ?? '') + JSON.stringify(e.userAgentMetadata ?? null))
          .digest('hex')
          .slice(0, 8);
  return `${device ?? 'custom'}|${e.orientation}|m${e.mobile ? 1 : 0}t${e.touch ? 1 : 0}|ua:${ua}`;
}

export function resolveDevice(
  params: Pick<StoryParams, 'device' | 'orientation' | 'viewport'>,
  registry: DeviceRegistry,
  fallback: Viewport,
  defaultDevice?: string,
): ResolvedDevice {
  const device = params.device ?? defaultDevice;
  if (device === undefined && params.orientation === undefined) {
    return { viewport: params.viewport ?? fallback };
  }

  let descriptor: DeviceDescriptor | undefined;
  if (device !== undefined) {
    descriptor = registry.get(device);
    if (!descriptor) {
      throw new UnknownDeviceError(device, closestKeys(device, registry.keys()));
    }
  }

  const base: Viewport = descriptor
    ? { width: descriptor.width, height: descriptor.height }
    : fallback;
  let viewport: Viewport;
  let orientation: Orientation;
  if (params.viewport) {
    viewport = params.viewport;
    orientation = defaultOrientation(viewport);
  } else {
    orientation = params.orientation ?? defaultOrientation(base);
    viewport = rotate(base, orientation);
  }

  const mobile = descriptor?.mobile ?? false;
  const emulation: DeviceEmulation = {
    mobile,
    touch: descriptor?.touch ?? false,
    orientation,
    angle: mobile && orientation === 'landscape' ? 90 : 0,
    ...(descriptor?.userAgent !== undefined && {
      userAgent: descriptor.userAgent,
    }),
    ...(descriptor?.userAgentMetadata !== undefined && {
      userAgentMetadata: descriptor.userAgentMetadata,
    }),
  };
  return {
    viewport,
    emulation,
    ...(device !== undefined && { device }),
    fingerprint: emulationFingerprint(device, emulation),
  };
}
