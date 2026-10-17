import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';
import type { ChangedRegion, DesignReferenceSpec, Viewport } from '../types.js';
import { diffImages } from './diff.js';
import type { VisibleColorEvidence } from './color-pairs.js';

/** Design targets have pixels but no capture-time DOM or computed styles. */
export interface DesignReferenceLedger {
  name: string;
  storyId: string;
  status: 'pass' | 'fail' | 'incompatible';
  reason?:
    | 'capture-key'
    | 'viewport'
    | 'device-scale-factor'
    | 'capture-kind'
    | 'reference-geometry'
    | 'current-geometry';
  comparisonId: string;
  referenceHash: string;
  currentHash: string;
  referenceImage: string;
  geometry: {
    viewport: Viewport;
    deviceScaleFactor: number;
    captureKind: 'viewport';
    expectedPixels: Viewport;
    referencePixels: Viewport;
    currentPixels: Viewport;
  };
  policy: { method: 'pixelmatch'; threshold: number; includeAA: false };
  mismatchPixels: number | null;
  mismatchPercent: number | null;
  rawMismatchPixels: number | null;
  regions: Array<ChangedRegion & { id: string; changedPixels?: number }>;
  /** Sampled co-located colors from visible mismatches, not inferred styles. */
  visibleColors?: VisibleColorEvidence;
  structure: { status: 'unavailable'; reason: 'design-reference-has-no-dom' };
}

export interface DesignReferenceCurrent {
  storyId: string;
  image: Buffer;
  viewport: Viewport;
  /** Jux captures at 1 today; supply the actual factor if that changes. */
  deviceScaleFactor?: number;
  captureKind?: 'viewport' | 'full-page';
}

/** Compare one saved image with a project-contained design PNG, without a
 * browser. Different file encodings can pass when their visible pixels match.
 * The exact byte hashes are retained as evidence, not used as the verdict. */
export async function compareDesignReference(input: {
  projectRoot: string;
  name: string;
  reference: DesignReferenceSpec;
  current: DesignReferenceCurrent;
  threshold?: number;
}): Promise<DesignReferenceLedger> {
  const { projectRoot, name, reference, current } = input;
  const threshold = input.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error('design reference threshold must be a number from 0 to 1');
  const dpr = reference.deviceScaleFactor ?? 1;
  if (!Number.isFinite(dpr) || dpr < 0.1 || dpr > 8)
    throw new Error('design reference deviceScaleFactor must be from 0.1 to 8');
  if (reference.captureKind && reference.captureKind !== 'viewport')
    throw new Error('only viewport design references are supported');
  const imagePath = await projectPngPath(projectRoot, reference.image);
  const target = await readFile(imagePath);
  const [targetMeta, currentMeta] = await Promise.all([
    sharp(target).metadata(),
    sharp(current.image).metadata(),
  ]);
  if (targetMeta.format !== 'png')
    throw new Error(`design reference ${name} must be a PNG image`);
  const targetPixels = dimensions(targetMeta);
  const currentPixels = dimensions(currentMeta);
  const expectedPixels = {
    width: reference.viewport.width * dpr,
    height: reference.viewport.height * dpr,
  };
  if (!Number.isInteger(expectedPixels.width) || !Number.isInteger(expectedPixels.height))
    throw new Error(
      'design reference viewport × deviceScaleFactor must yield whole pixels',
    );
  const policy = { method: 'pixelmatch' as const, threshold, includeAA: false as const };
  const referenceHash = hash(target);
  const currentHash = hash(current.image);
  const geometry = {
    viewport: reference.viewport,
    deviceScaleFactor: dpr,
    captureKind: 'viewport' as const,
    expectedPixels,
    referencePixels: targetPixels,
    currentPixels,
  };
  const comparisonId = hash(
    Buffer.from(
      JSON.stringify({
        name,
        storyId: reference.storyId,
        referenceHash,
        currentHash,
        geometry,
        policy,
      }),
    ),
  );
  const base: DesignReferenceLedger = {
    name,
    storyId: reference.storyId,
    status: 'incompatible',
    comparisonId,
    referenceHash,
    currentHash,
    referenceImage: imagePath,
    geometry,
    policy,
    mismatchPixels: null,
    mismatchPercent: null,
    rawMismatchPixels: null,
    regions: [],
    structure: { status: 'unavailable', reason: 'design-reference-has-no-dom' },
  };
  const reason =
    reference.storyId !== current.storyId
      ? 'capture-key'
      : reference.viewport.width !== current.viewport.width ||
          reference.viewport.height !== current.viewport.height
        ? 'viewport'
        : dpr !== (current.deviceScaleFactor ?? 1)
          ? 'device-scale-factor'
          : (reference.captureKind ?? 'viewport') !== (current.captureKind ?? 'viewport')
            ? 'capture-kind'
            : targetPixels.width !== expectedPixels.width ||
                targetPixels.height !== expectedPixels.height
              ? 'reference-geometry'
              : currentPixels.width !== expectedPixels.width ||
                  currentPixels.height !== expectedPixels.height
                ? 'current-geometry'
                : undefined;
  if (reason) return { ...base, reason };
  const diff = await diffImages(target, current.image, {
    threshold,
    includeVisibleColors: true,
  });
  // The geometry checks above ensure diffImages can never silently compare
  // different dimensions; keep this guard if its implementation changes.
  if (diff.dimensionMismatch) return { ...base, reason: 'current-geometry' };
  return {
    ...base,
    status: diff.mismatchPixels === 0 ? 'pass' : 'fail',
    mismatchPixels: diff.mismatchPixels,
    mismatchPercent: diff.mismatchPercent,
    rawMismatchPixels: diff.rawMismatchPixels ?? 0,
    ...(diff.visibleColors ? { visibleColors: diff.visibleColors } : {}),
    regions: (diff.rankedChangedRegions ?? diff.changedRegions).map((r, i) => ({
      ...r,
      id: `${comparisonId.slice(0, 16)}:${i + 1}`,
    })),
  };
}

async function projectPngPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || !path.toLowerCase().endsWith('.png'))
    throw new Error('design reference image must be a project-relative PNG path');
  const [project, image] = await Promise.all([
    realpath(root),
    realpath(resolve(root, path)),
  ]);
  const within = relative(project, image);
  if (
    !within ||
    within === '..' ||
    within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(within)
  )
    throw new Error('design reference image must remain inside the project root');
  return image;
}

function dimensions(meta: { width?: number; height?: number }): Viewport {
  if (!meta.width || !meta.height)
    throw new Error('design reference comparison requires raster images with dimensions');
  return { width: meta.width, height: meta.height };
}

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
