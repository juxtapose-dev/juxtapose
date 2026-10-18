import { createHash } from 'node:crypto';
import { defaultOrientation, resolveDevices } from '../browser/devices.js';
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

/** The named device, or UnknownDeviceError with the closest keys. */
export function lookupDevice(name: string, registry: DeviceRegistry): DeviceDescriptor {
  const descriptor = registry.get(name);
  if (!descriptor) throw new UnknownDeviceError(name, closestKeys(name, registry.keys()));
  return descriptor;
}

function rotate(size: Viewport, to: Orientation): Viewport {
  return defaultOrientation(size) === to
    ? { width: size.width, height: size.height }
    : { width: size.height, height: size.width };
}

/** What the page is emulated as, not what the device is called: the name is
 *  recorded separately (`device`), and `mobile` renamed to `iphone-15` emulates
 *  the same thing, so it must not read as a previous device emulation. */
export function emulationFingerprint(e: DeviceEmulation): string {
  const ua =
    e.userAgent === undefined && e.userAgentMetadata === undefined
      ? 'none'
      : createHash('sha256')
          .update((e.userAgent ?? '') + JSON.stringify(e.userAgentMetadata ?? null))
          .digest('hex')
          .slice(0, 8);
  return `${e.orientation}|m${e.mobile ? 1 : 0}t${e.touch ? 1 : 0}|ua:${ua}`;
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

  const descriptor = device !== undefined ? lookupDevice(device, registry) : undefined;

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
    fingerprint: emulationFingerprint(emulation),
  };
}

/** The project's side of a capture's device: its registry and defaults. */
export interface CaptureDeviceDefaults {
  /** Default: the built-ins. */
  devices?: DeviceRegistry;
  /** The project's `device` and `orientation`, below the story's own. */
  defaultDevice?: string;
  defaultOrientation?: Orientation;
}

/** Built-in presets, for callers that pass no `devices`. */
let builtinDevices: DeviceRegistry | undefined;

/**
 * The capture's device from its params and the project defaults. The one
 * place the precedence lives: captureStory captures with it and
 * `jux config --explain` reports it, so they cannot disagree.
 *
 * `fallback` (the project viewport) is the size only when no layer sets a
 * device: a device at any layer, the project's included, supplies the size,
 * and a story, variant or live `viewport` overrides that. The story's
 * orientation wins over the project's.
 */
export function resolveCaptureDevice(
  params: Pick<StoryParams, 'device' | 'orientation' | 'viewport'>,
  defaults: CaptureDeviceDefaults,
  fallback: Viewport,
): ResolvedDevice {
  const orientation = params.orientation ?? defaults.defaultOrientation;
  return resolveDevice(
    {
      ...(params.device !== undefined ? { device: params.device } : {}),
      ...(params.viewport !== undefined ? { viewport: params.viewport } : {}),
      ...(orientation !== undefined ? { orientation } : {}),
    },
    defaults.devices ?? (builtinDevices ??= resolveDevices()),
    fallback,
    defaults.defaultDevice,
  );
}
