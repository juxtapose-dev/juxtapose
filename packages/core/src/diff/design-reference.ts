import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
    captureKind: 'viewport' | 'full-page';
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
  /** Image bounds for full-page captures; layout viewport otherwise. */
  viewport: Viewport;
  /** Browser layout viewport, required for full-page captures. */
  layoutViewport?: Viewport;
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
  /** Optional run-local cache for derived analysis. Source image bytes are still hashed. */
  cacheDir?: string;
}): Promise<DesignReferenceLedger> {
  const { projectRoot, name, reference, current } = input;
  const threshold = input.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error('design reference threshold must be a number from 0 to 1');
  const dpr = reference.deviceScaleFactor ?? 1;
  if (!Number.isFinite(dpr) || dpr < 0.1 || dpr > 8)
    throw new Error('design reference deviceScaleFactor must be from 0.1 to 8');
  const referenceKind = reference.captureKind ?? 'viewport';
  const currentKind =
    current.captureKind ?? (current.layoutViewport ? 'full-page' : 'viewport');
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
  const viewportPixels = {
    width: reference.viewport.width * dpr,
    height: reference.viewport.height * dpr,
  };
  if (!Number.isInteger(viewportPixels.width) || !Number.isInteger(viewportPixels.height))
    throw new Error(
      'design reference viewport × deviceScaleFactor must yield whole pixels',
    );
  const expectedPixels = referenceKind === 'full-page' ? targetPixels : viewportPixels;
  const policy = { method: 'pixelmatch' as const, threshold, includeAA: false as const };
  const referenceHash = hash(target);
  const currentHash = hash(current.image);
  const geometry = {
    viewport: reference.viewport,
    deviceScaleFactor: dpr,
    captureKind: referenceKind,
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
      : referenceKind !== currentKind
        ? 'capture-kind'
        : reference.viewport.width !==
              (current.layoutViewport ?? current.viewport).width ||
            reference.viewport.height !==
              (current.layoutViewport ?? current.viewport).height
          ? 'viewport'
          : dpr !== (current.deviceScaleFactor ?? 1)
            ? 'device-scale-factor'
            : targetPixels.width < viewportPixels.width ||
                targetPixels.height < viewportPixels.height ||
                (referenceKind === 'viewport' &&
                  (targetPixels.width !== expectedPixels.width ||
                    targetPixels.height !== expectedPixels.height))
              ? 'reference-geometry'
              : currentPixels.width !== expectedPixels.width ||
                  currentPixels.height !== expectedPixels.height ||
                  current.viewport.width * dpr !== currentPixels.width ||
                  current.viewport.height * dpr !== currentPixels.height
                ? 'current-geometry'
                : undefined;
  if (reason) return { ...base, reason };
  const cached = input.cacheDir
    ? await readCachedLedger(input.cacheDir, comparisonId, base)
    : null;
  if (cached) return cached;
  const diff = await diffImages(target, current.image, {
    threshold,
    includeVisibleColors: true,
  });
  // The geometry checks above ensure diffImages can never silently compare
  // different dimensions; keep this guard if its implementation changes.
  if (diff.dimensionMismatch) return { ...base, reason: 'current-geometry' };
  const ledger: DesignReferenceLedger = {
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
  if (input.cacheDir) await writeCachedLedger(input.cacheDir, ledger);
  return ledger;
}

/** A new analysis algorithm or ledger meaning must use a new directory version. */
const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 1024 * 1024;

async function safeCacheDir(dir: string, create: boolean): Promise<string | null> {
  try {
    if (create) await mkdir(dir, { recursive: true });
    if (!(await lstat(dir)).isDirectory()) return null;
    const real = await realpath(dir);
    // Refuse a link at the cache directory itself. Canonicalize its parent so
    // macOS's /var → /private/var alias does not make a real directory miss.
    if (real !== join(await realpath(dirname(dir)), basename(dir))) return null;
    return real;
  } catch {
    return null;
  }
}

async function readCachedLedger(
  dir: string,
  comparisonId: string,
  expected: DesignReferenceLedger,
): Promise<DesignReferenceLedger | null> {
  const root = await safeCacheDir(dir, false);
  if (!root) return null;
  const file = join(root, `${comparisonId}.json`);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const entry = parsed as { version?: unknown; checksum?: unknown; ledger?: unknown };
    if (
      entry.version !== CACHE_VERSION ||
      !entry.ledger ||
      typeof entry.ledger !== 'object'
    )
      return null;
    const ledger = entry.ledger as DesignReferenceLedger;
    if (
      ledger.comparisonId !== comparisonId ||
      ledger.referenceHash !== expected.referenceHash ||
      ledger.currentHash !== expected.currentHash ||
      ledger.referenceImage !== expected.referenceImage ||
      ledger.storyId !== expected.storyId ||
      ledger.name !== expected.name ||
      !['pass', 'fail'].includes(ledger.status) ||
      !Array.isArray(ledger.regions) ||
      JSON.stringify(ledger.geometry) !== JSON.stringify(expected.geometry) ||
      JSON.stringify(ledger.policy) !== JSON.stringify(expected.policy)
    )
      return null;
    if (entry.checksum !== hash(Buffer.from(JSON.stringify(ledger)))) return null;
    return ledger;
  } catch {
    return null;
  }
}

async function writeCachedLedger(
  dir: string,
  ledger: DesignReferenceLedger,
): Promise<void> {
  const root = await safeCacheDir(dir, true);
  if (!root) return;
  const payload = JSON.stringify({
    version: CACHE_VERSION,
    ledger,
    checksum: hash(Buffer.from(JSON.stringify(ledger))),
  });
  if (Buffer.byteLength(payload) > MAX_CACHE_BYTES) return;
  const temporary = join(root, `.${ledger.comparisonId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, payload, { flag: 'wx' });
    await rename(temporary, join(root, `${ledger.comparisonId}.json`));
  } catch {
    // A read-only run directory or broken cache must not change a visual verdict.
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
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
