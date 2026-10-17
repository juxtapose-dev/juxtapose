/** A co-located color pair among pixels marked by Pixelmatch. */
export interface VisibleColorPair {
  reference: [number, number, number, number];
  current: [number, number, number, number];
  /** Count within the deterministic sample, not necessarily the whole image. */
  pixels: number;
  sharePercent: number;
}

export interface VisibleColorEvidence {
  sampledPixels: number;
  comparedPixels: number;
  visibleMismatchSamples: number;
  pairs: VisibleColorPair[];
}

const MAX_SAMPLES = 1_000_000;
const MAX_CANDIDATES = 64;

/**
 * Find frequent target/current RGBA pairs in Pixelmatch's sparse diff mask.
 * The two-pass bounded-candidate scan avoids a map entry for every color pair
 * in a large photo. It describes observed pixels, never a CSS property.
 */
export function visibleColorPairs(
  reference: Buffer,
  current: Buffer,
  mask: Buffer,
  width: number,
  height: number,
): VisibleColorEvidence {
  const total = width * height;
  const samples = Math.min(total, MAX_SAMPLES);
  const candidates = new Map<string, number>();
  let visibleMismatchSamples = 0;
  const scan = (visit: (key: string) => void) => {
    for (let n = 0; n < samples; n++) {
      const pixel = Math.floor(((n + 0.5) * total) / samples);
      const offset = pixel * 4;
      if (mask[offset + 3] === 0) continue;
      const pair = `${pack(reference, offset)}:${pack(current, offset)}`;
      visit(pair);
    }
  };
  scan((key) => {
    visibleMismatchSamples++;
    const count = candidates.get(key);
    if (count !== undefined) candidates.set(key, count + 1);
    else if (candidates.size < MAX_CANDIDATES) candidates.set(key, 1);
    else {
      for (const [candidate, votes] of candidates) {
        if (votes === 1) candidates.delete(candidate);
        else candidates.set(candidate, votes - 1);
      }
    }
  });
  for (const key of candidates.keys()) candidates.set(key, 0);
  scan((key) => {
    const count = candidates.get(key);
    if (count !== undefined) candidates.set(key, count + 1);
  });
  return {
    sampledPixels: samples,
    comparedPixels: total,
    visibleMismatchSamples,
    pairs: [...candidates]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([key, pixels]) => {
        const [referenceColor, currentColor] = key.split(':').map(Number);
        return {
          reference: unpack(referenceColor!) as [number, number, number, number],
          current: unpack(currentColor!) as [number, number, number, number],
          pixels,
          sharePercent: Math.round((10_000 * pixels) / visibleMismatchSamples) / 100,
        };
      }),
  };
}

function pack(data: Buffer, offset: number): number {
  return (
    data[offset]! * 16_777_216 +
    (data[offset + 1]! << 16) +
    (data[offset + 2]! << 8) +
    data[offset + 3]!
  );
}

function unpack(value: number): number[] {
  return [
    Math.floor(value / 16_777_216) % 256,
    Math.floor(value / 65_536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ];
}
