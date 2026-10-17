import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { compareDesignReference } from './design-reference.js';
import { checkProjectSettle } from '../capture/settle-options.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jux-reference-'));
  roots.push(root);
  const dir = join(root, 'design');
  await mkdir(dir);
  const target = await sharp({
    create: { width: 4, height: 3, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  await writeFile(join(dir, 'card.png'), target);
  const reference = {
    storyId: 'card--default__mobile',
    image: 'design/card.png',
    viewport: { width: 4, height: 3 },
    deviceScaleFactor: 1,
    captureKind: 'viewport' as const,
  };
  const current = {
    storyId: reference.storyId,
    image: await sharp(target).webp({ lossless: true }).toBuffer(),
    viewport: reference.viewport,
    deviceScaleFactor: 1,
    captureKind: 'viewport' as const,
  };
  return { root, target, reference, current };
}

describe('compareDesignReference', () => {
  it('accepts equal pixels despite different encodings and makes absent DOM explicit', async () => {
    const f = await fixture();
    const result = await compareDesignReference({
      projectRoot: f.root,
      name: 'mobile',
      reference: f.reference,
      current: f.current,
    });
    expect(result.status).toBe('pass');
    expect(result.mismatchPixels).toBe(0);
    expect(result.visibleColors?.pairs).toEqual([]);
    expect(result.referenceHash).not.toBe(result.currentHash);
    expect(result.structure).toEqual({
      status: 'unavailable',
      reason: 'design-reference-has-no-dom',
    });
  });

  it('reports a reproducible changed region and comparison id', async () => {
    const f = await fixture();
    const altered = await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#000000' },
    })
      .webp({ lossless: true })
      .toBuffer();
    const opts = {
      projectRoot: f.root,
      name: 'mobile',
      reference: f.reference,
      current: { ...f.current, image: altered },
    };
    const a = await compareDesignReference(opts);
    const b = await compareDesignReference(opts);
    expect(a.status).toBe('fail');
    expect(a.mismatchPixels).toBe(12);
    expect(a.regions).toHaveLength(1);
    expect(a.visibleColors).toMatchObject({
      sampledPixels: 12,
      comparedPixels: 12,
      visibleMismatchSamples: 12,
      pairs: [
        {
          reference: [255, 255, 255, 255],
          current: [0, 0, 0, 255],
          pixels: 12,
          sharePercent: 100,
        },
      ],
    });
    expect(a.regions[0]!.id).toBe(b.regions[0]!.id);
    expect(a.comparisonId).toBe(b.comparisonId);
    const differentPolicy = await compareDesignReference({ ...opts, threshold: 0.05 });
    expect(differentPolicy.comparisonId).not.toBe(a.comparisonId);
    expect(differentPolicy.regions[0]!.id).not.toBe(a.regions[0]!.id);
  });

  it('does not suggest a color edit for pixels accepted by the tolerance', async () => {
    const f = await fixture();
    const nearWhite = await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#fefefd' },
    })
      .webp({ lossless: true })
      .toBuffer();
    const result = await compareDesignReference({
      projectRoot: f.root,
      name: 'mobile',
      reference: f.reference,
      current: { ...f.current, image: nearWhite },
    });
    expect(result.status).toBe('pass');
    expect(result.rawMismatchPixels).toBe(12);
    expect(result.visibleColors?.visibleMismatchSamples).toBe(0);
    expect(result.visibleColors?.pairs).toEqual([]);
  });

  it('rejects geometry and capture key mismatches without pixel verdicts', async () => {
    const f = await fixture();
    for (const [current, reason] of [
      [{ ...f.current, storyId: 'another' }, 'capture-key'],
      [{ ...f.current, viewport: { width: 5, height: 3 } }, 'viewport'],
      [{ ...f.current, deviceScaleFactor: 2 }, 'device-scale-factor'],
      [{ ...f.current, captureKind: 'full-page' as const }, 'capture-kind'],
      [
        { ...f.current, image: await sharp(f.target).resize(5, 3).png().toBuffer() },
        'current-geometry',
      ],
    ] as const) {
      const result = await compareDesignReference({
        projectRoot: f.root,
        name: 'mobile',
        reference: f.reference,
        current,
      });
      expect(result.status).toBe('incompatible');
      expect(result.reason).toBe(reason);
      expect(result.mismatchPixels).toBeNull();
    }
    const badTarget = await compareDesignReference({
      projectRoot: f.root,
      name: 'mobile',
      reference: { ...f.reference, viewport: { width: 5, height: 3 } },
      current: { ...f.current, viewport: { width: 5, height: 3 } },
    });
    expect(badTarget.reason).toBe('reference-geometry');
  });

  it('validates project config shape at runtime', async () => {
    const f = await fixture();
    expect(() =>
      checkProjectSettle({ designReferences: { mobile: f.reference } }),
    ).not.toThrow();
    expect(() =>
      checkProjectSettle({
        designReferences: { mobile: { ...f.reference, deviceScaleFactor: -1 } },
      }),
    ).toThrow();
  });

  it('rejects an escaping path or symlink', async () => {
    const f = await fixture();
    await expect(
      compareDesignReference({
        projectRoot: f.root,
        name: 'mobile',
        reference: { ...f.reference, image: '../outside.png' },
        current: f.current,
      }),
    ).rejects.toThrow();
    const outside = await mkdtemp(join(tmpdir(), 'jux-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'outside.png'), f.target);
    await symlink(join(outside, 'outside.png'), join(f.root, 'design', 'link.png'));
    await expect(
      compareDesignReference({
        projectRoot: f.root,
        name: 'mobile',
        reference: { ...f.reference, image: 'design/link.png' },
        current: f.current,
      }),
    ).rejects.toThrow('inside the project root');
  });
});
