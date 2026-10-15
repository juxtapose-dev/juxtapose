// What turns Chrome's frame into the bytes the hash is taken over.
//
// Chrome encodes the capture itself: `Page.captureScreenshot` with
// `format: 'webp', quality: 100` returns a lossless (VP8L) WebP, so there is no
// PNG to decode and re-encode in Node. All this file does is make that WebP
// independent of anything but the pixels.
//
// Chrome wraps the VP8L bitstream as VP8X + ICCP + VP8L. The ICC profile is
// the frame's colour space, which `--force-color-profile=srgb` pins, but it is
// redundant for these pinned sRGB pixels. A decoder that honours it shifts
// channels by ±1 (measured on Chrome 151), so
// the ICCP chunk is dropped, the VP8X ICC flag cleared and the RIFF size
// rewritten. The pixels are untouched: the VP8L chunk is copied byte for byte.

/**
 * Recorded as `env.encoder` on every report and approval. A baseline whose
 * entry carries anything else was encoded another way, so its hash cannot
 * match even when the pixels match; `jux run` and `jux doctor` say so instead of
 * reporting each story as a regression. Change it whenever the bytes for the
 * same pixels would change.
 */
export const CAPTURE_ENCODER = 'chrome-webp-lossless';

/** How `env.encoder` named the encoder before this one: the libvips version
 *  sharp re-encoded the PNG with ("8.17.3"). */
export function describeEncoder(encoder: string | undefined): string {
  if (encoder === undefined || encoder === 'unrecorded') return 'an unrecorded encoder';
  if (encoder === CAPTURE_ENCODER) return "Chrome's lossless WebP";
  return /^\d/.test(encoder) ? `libvips ${encoder} (sharp)` : encoder;
}

const VP8X_ICC = 0x20;

/**
 * Chrome's WebP with the ICC profile removed. Throws on anything but a single
 * lossless image: a lossy (VP8) frame would hash deterministically yet fill
 * every diff with compression noise, so it must not pass silently.
 */
export function canonicalWebp(webp: Buffer): Buffer {
  if (
    webp.length < 20 ||
    webp.toString('latin1', 0, 4) !== 'RIFF' ||
    webp.toString('latin1', 8, 12) !== 'WEBP'
  )
    throw new Error('jux: the browser did not return a WebP screenshot');
  if (webp.readUInt32LE(4) !== webp.length - 8)
    throw new Error('jux: invalid WebP screenshot length');
  const parts: Buffer[] = [];
  let lossless = 0;
  for (let o = 12; o < webp.length;) {
    if (o + 8 > webp.length) throw new Error('jux: truncated WebP screenshot');
    const type = webp.toString('latin1', o, o + 4);
    const size = webp.readUInt32LE(o + 4);
    const end = o + 8 + size + (size & 1);
    if (end > webp.length) throw new Error('jux: truncated WebP screenshot');
    if (type === 'VP8X' && size !== 10)
      throw new Error('jux: invalid WebP extended header');
    if (type === 'VP8L') lossless++;
    else if (type !== 'VP8X' && type !== 'ICCP')
      // VP8 is lossy; ALPH/ANIM/ANMF would mean the same. Chrome below
      // quality 100 (99 included) returns VP8.
      throw new Error(
        `jux: the browser returned a WebP with a ${type.trim()} chunk; captures must be a single lossless (VP8L) image`,
      );
    if (type !== 'ICCP') {
      const chunk = Buffer.from(webp.subarray(o, end));
      if (type === 'VP8X') chunk[8] = chunk[8]! & ~VP8X_ICC;
      parts.push(chunk);
    }
    o = end;
  }
  if (lossless !== 1)
    throw new Error('jux: the browser returned a WebP without a lossless (VP8L) image');
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** The chunk ids in order, for tests and diagnostics. */
export function webpChunks(webp: Buffer): string[] {
  const ids: string[] = [];
  for (let o = 12; o + 8 <= webp.length;) {
    ids.push(webp.toString('latin1', o, o + 4).trim());
    const size = webp.readUInt32LE(o + 4);
    o += 8 + size + (size & 1);
  }
  return ids;
}

/**
 * One paragraph for a run whose failures include baselines from another
 * encoder (`DiffResult.baselineEncoder`), or '' when there are none. Upgrading
 * across an encoder change fails every story once; without this a 1,000-story
 * suite reads as 1,000 regressions.
 */
export function describeEncoderFailures(
  results: readonly {
    status?: string;
    baselineEncoder?: string;
    mismatchPixels: number;
    baselineImage?: 'unavailable';
    error?: string;
  }[],
): string {
  const hit = results.filter(
    (r) =>
      r.baselineEncoder !== undefined && (r.status === undefined || r.status === 'fail'),
  );
  if (hit.length === 0) return '';
  const from = [...new Set(hit.map((r) => describeEncoder(r.baselineEncoder)))].sort();
  // Only a story whose baseline image was here and diffed can be said to show
  // no change; one known by hash alone says nothing either way.
  const same = hit.filter(
    (r) =>
      r.baselineImage === undefined && r.error === undefined && r.mismatchPixels === 0,
  ).length;
  const n = hit.length;
  return (
    `${n} failing ${n === 1 ? 'story was' : 'stories were'} approved with a previous encoder ` +
    `(${from.join(', ')}). Captures are now ${describeEncoder(CAPTURE_ENCODER)}, so ` +
    `${n === 1 ? 'its hash' : 'their hashes'} changed whether or not a pixel did` +
    (same > 0 ? ` (${same} of ${n} show no counted pixel differences)` : '') +
    `. This is a one-time re-baseline: review the run, then \`jux approve --all\`.`
  );
}
