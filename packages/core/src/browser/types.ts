export interface Viewport {
  width: number;
  height: number;
}

export type Orientation = 'portrait' | 'landscape';

/** CDP `Emulation.UserAgentMetadata`: the client-hint values behind `navigator.userAgentData`. */
export interface UserAgentMetadata {
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  brands?: { brand: string; version: string }[];
}

/** A named device's shape. No device scale factor: captures are always 1x. */
export interface DeviceDescriptor {
  width: number;
  height: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
  userAgentMetadata?: UserAgentMetadata;
}

/**
 * What the browser layer applies for a device. Lives here, not in devices.ts,
 * because the browser layer imports nothing else from core.
 */
export interface DeviceEmulation {
  mobile: boolean;
  touch: boolean;
  orientation: Orientation;
  angle: 0 | 90;
  userAgent?: string;
  userAgentMetadata?: UserAgentMetadata;
}
