// Cache-backed baseline store — the default.
//
// A project commits hashes and metadata, never pixels:
//   - `juxtapose.manifest.json`: the per-story hash. This alone decides
//     pass/fail, so CI needs no image to detect a change.
//     The same entry carries the approved structure inline, so CI can also say
//     which elements changed without an image. One committed file, like a
//     lockfile; it is regenerated on a merge conflict, not hand-merged.
// Everything under `.juxtapose/` is machine-local and ignored as one line.
// Images live in a local, git-ignored cache keyed by their own sha256
// (`<hash>.webp`). Content addressing is what makes this safe to rebuild
// from anywhere: a main-branch CI run saves the directory, a PR run restores
// it, and two caches merge without conflict because a name cannot hold
// different bytes. It also means any commit's manifest finds its image if that
// image was ever captured here.
//
// A cache miss is a normal answer, not an error: a clone that never ran the
// story, or a CI job with a cold cache, reports the failure by hash and
// structure and says the image is unavailable.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalMeta,
  BaselineImageLookup,
  BaselineManifest,
  BaselineStore,
  StructureSnapshot,
} from '../types.js';
import { encodeStoryId } from './git-store.js';
import {
  MANIFEST_NAME,
  readManifestFile,
  readManifestFileSync,
  writeManifestFile,
} from './manifest-file.js';
import { decodeStructure } from '../capture/structure.js';
import { hashImage } from './status.js';

/** A manifest is repo content, so its hash is untrusted input to a path join. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const DEFAULT_CACHE_DIR = '.juxtapose/cache/baselines';
/** Where half-written images live until they are renamed into the cache. Not
 *  inside the cache: CI saves that directory, and a killed process must not
 *  leave debris in what gets saved. */
export const DEFAULT_TMP_DIR = '.juxtapose/tmp';
/** A temp file this old belongs to a process that died. */
const STALE_TMP_MS = 60 * 60 * 1000;

/** The temp dir for a cache dir: the default's lives beside it under
 *  `.juxtapose`; a custom cache dir gets `<dir>.tmp`, in the same parent so the
 *  rename never crosses a filesystem. */
export function tmpDirFor(cacheDir: string | undefined): string {
  return cacheDir === undefined || cacheDir.replace(/\/+$/, '') === DEFAULT_CACHE_DIR
    ? DEFAULT_TMP_DIR
    : `${cacheDir.replace(/\/+$/, '')}.tmp`;
}

/** Where the repo-backed store kept images. Read-only here, so a project that
 *  upgrades keeps its diffs until it migrates. */
export const LEGACY_IMAGE_DIR = '.juxtapose/baselines';

export interface CacheStoreOptions {
  projectRoot: string;
  /** Image cache, relative to projectRoot. Default `.juxtapose/cache/baselines`. */
  dir?: string;
  /** Told when a directory is refused because it is a link or leads outside
   *  the project. Caching is skipped; nothing is ever written through it. */
  onWarning?: (message: string) => void;
}

export class CacheBaselineStore implements BaselineStore {
  private readonly cacheDir: string;
  private readonly tmpDir: string;
  private swept = false;
  private readonly legacyDir: string;
  private readonly manifestPath: string;
  private readonly root: string;
  private readonly warn: (message: string) => void;
  private readonly refused = new Set<string>();

  constructor(opts: CacheStoreOptions) {
    this.root = opts.projectRoot;
    this.warn = opts.onWarning ?? (() => {});
    this.cacheDir = path.join(opts.projectRoot, opts.dir ?? DEFAULT_CACHE_DIR);
    this.tmpDir = path.join(opts.projectRoot, tmpDirFor(opts.dir));
    this.legacyDir = path.join(opts.projectRoot, LEGACY_IMAGE_DIR);
    this.manifestPath = path.join(opts.projectRoot, MANIFEST_NAME);
  }

  private cachePath(hash: string): string {
    return path.join(this.cacheDir, `${hash}.webp`);
  }

  private legacyImagePath(storyId: string): string {
    return path.join(this.legacyDir, `${encodeStoryId(storyId)}.webp`);
  }

  async lookup(storyId: string): Promise<BaselineImageLookup> {
    const entry = (await this.readManifest()).baselines[storyId];
    if (!entry) return { kind: 'unavailable', reason: 'no-manifest-entry' };
    if (!SHA256_HEX.test(entry.hash))
      return { kind: 'unavailable', reason: 'not-in-cache' };
    // A cache file is trusted only if its bytes still hash to its name: a
    // truncated restore or a hand-edit must read as "not there", never as the
    // baseline the manifest approved.
    for (const file of [this.cachePath(entry.hash), this.legacyImagePath(storyId)]) {
      const bytes = await readFile(file).catch(() => null);
      if (bytes && hashImage(bytes) === entry.hash) {
        // An image found in the old committed layout is copied into the cache:
        // once the migration commit untracks it, git deletes it from every
        // clone that pulls, and the cache is the copy that survives.
        if (file !== this.cachePath(entry.hash))
          await this.keepImage(bytes).catch(() => {});
        return { kind: 'found', image: bytes };
      }
    }
    return { kind: 'unavailable', reason: 'not-in-cache', hash: entry.hash };
  }

  async get(storyId: string): Promise<Buffer | null> {
    const found = await this.lookup(storyId);
    return found.kind === 'found' ? found.image : null;
  }

  locate(storyId: string): string | undefined {
    // Sync because the handoff asks while building a prompt. Same trust rule
    // as lookup: only a path whose bytes still match the approved hash.
    const hash = readManifestFileSync(this.manifestPath).baselines[storyId]?.hash;
    if (hash === undefined || !SHA256_HEX.test(hash)) return undefined;
    for (const file of [this.cachePath(hash), this.legacyImagePath(storyId)]) {
      try {
        if (hashImage(readFileSync(file)) === hash) return file;
      } catch {
        // not there
      }
    }
    return undefined;
  }

  /**
   * A directory jux may write into: a real directory, not a link, whose real
   * path is where it claims to be. A repo can commit `.juxtapose/tmp` as a
   * symlink; writing or deleting through it would reach wherever it points.
   * Refused once per directory, with a warning, and the caller skips the work.
   */
  private async ensureRealDir(dir: string): Promise<boolean> {
    const refuse = (why: string) => {
      if (!this.refused.has(dir)) {
        this.refused.add(dir);
        this.warn(`not using ${path.relative(this.root, dir)}: ${why}`);
      }
      return false;
    };
    // Check every part of the path that already exists BEFORE creating
    // anything: `mkdir -p` through a symlinked `.juxtapose` would leave empty
    // directories at the link's target.
    const rootReal = await realpath(this.root);
    const rel = path.relative(this.root, dir);
    let walked = this.root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      walked = path.join(walked, part);
      const info = await lstat(walked).catch(() => null);
      if (info === null) break;
      if (info.isSymbolicLink() || !info.isDirectory())
        return refuse('it is a link or not a directory');
      if (
        (await realpath(walked)) !== path.join(rootReal, path.relative(this.root, walked))
      )
        return refuse('it resolves outside the project');
    }
    await mkdir(dir, { recursive: true });
    // Swapped for a link between the check and the mkdir? Look again.
    return (await realpath(dir)) === path.join(rootReal, rel)
      ? true
      : refuse('it resolves outside the project');
  }

  /** Same test without creating anything, for deletes. */
  private async isRealDir(dir: string): Promise<boolean> {
    const info = await lstat(dir).catch(() => null);
    return info !== null && info.isDirectory() && !info.isSymbolicLink();
  }

  /**
   * Delete temp files older than an hour: a process killed mid-write (kill -9,
   * a CI timeout) leaves one, and nothing else ever would. Best effort, and
   * only regular files in real directories, never following a link. The cache
   * dir is swept too, for temp files an older version left inside it.
   */
  async sweepStaleTmp(now = Date.now()): Promise<void> {
    for (const dir of [this.tmpDir, this.cacheDir]) {
      if (!(await this.isRealDir(dir))) continue;
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.filter((n) => n.endsWith('.tmp'))) {
        const file = path.join(dir, name);
        const info = await lstat(file).catch(() => null);
        if (info?.isFile() && now - info.mtimeMs > STALE_TMP_MS) {
          await rm(file, { force: true });
        }
      }
    }
  }

  /**
   * Cache an image without touching the manifest. A passing story's capture is
   * by definition the approved image, so a run that keeps it is how a CI job
   * (or a clone that never approved anything) fills the cache that later
   * failures diff against. Content-addressed, so repeating it is free.
   */
  async keepImage(image: Buffer): Promise<void> {
    const hash = hashImage(image);
    const file = this.cachePath(hash);
    // An existing file counts only if its bytes still hash to its name: a
    // truncated restore must be replaced, or the entry never heals.
    const valid = async () => {
      const bytes = await readFile(file).catch(() => null);
      return bytes !== null && hashImage(bytes) === hash;
    };
    if (await valid()) return;
    if (!(await this.ensureRealDir(this.cacheDir))) return;
    if (!(await this.ensureRealDir(this.tmpDir))) return;
    if (!this.swept) {
      this.swept = true;
      await this.sweepStaleTmp().catch(() => {});
    }
    // Write-then-rename: a reader (or a CI cache save) never sees half an image
    // under a name that promises its hash. The suffix is random because the
    // pid alone collides between concurrent calls in one process.
    const tmp = path.join(this.tmpDir, `${hash}.${randomUUID()}.tmp`);
    try {
      // `wx`: never overwrite, and never open something already there.
      await writeFile(tmp, image, { flag: 'wx' });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      // A concurrent writer that got there first is success, not failure.
      if (await valid()) return;
      throw err;
    }
  }

  async put(storyId: string, image: Buffer, meta: ApprovalMeta): Promise<void> {
    const hash = hashImage(image);
    await this.keepImage(image);
    // A previous baseline's sidecar must not outlive its pixels: a capture
    // approved without structure would otherwise inherit the old one.
    const manifest = await this.readManifest();
    manifest.baselines[storyId] = { ...meta, hash };
    await this.writeManifest(manifest);
  }

  async remove(storyId: string): Promise<void> {
    // The image stays: it is named by content, so another story or another
    // commit's manifest may still point at it.
    const manifest = await this.readManifest();
    delete manifest.baselines[storyId];
    await this.writeManifest(manifest);
  }

  async putStructure(storyId: string, structure: Buffer): Promise<void> {
    const manifest = await this.readManifest();
    const entry = manifest.baselines[storyId];
    if (!entry)
      throw new Error(`no manifest entry for ${storyId} to attach structure to`);
    // `put` already wrote the entry, so this is its second write; stores are
    // not batched because approvals are one story at a time.
    const { structureHash, ...rest } = decodeStructure(structure);
    manifest.baselines[storyId] = { ...entry, structureHash, structure: rest };
    await this.writeManifest(manifest);
  }

  async getStructure(storyId: string): Promise<Buffer | null> {
    const entry = (await this.readManifest()).baselines[storyId];
    if (entry?.structure && entry.structureHash) {
      // Same plain JSON `decodeStructure` reads from any other source.
      return Buffer.from(
        JSON.stringify({ ...entry.structure, structureHash: entry.structureHash }),
      );
    }
    // Old layout: gzip beside the image.
    return readFile(
      path.join(this.legacyDir, `${encodeStoryId(storyId)}.structure.json.gz`),
    ).catch(() => null);
  }

  /**
   * Fold legacy `.structure.json.gz` sidecars into the manifest, for stories
   * whose entry has no structure yet. Nothing is captured and nothing is
   * approved: an entry's hash is never touched, so a story that is failing
   * stays failing. A sidecar is taken only when it belongs to the approved
   * baseline: its structureHash equals the entry's, or, for an entry that
   * recorded none, the legacy image beside it hashes to the entry's hash.
   * One write. `skipped` lists stories whose sidecar could not be matched.
   */
  async migrateLegacyStructures(): Promise<{ migrated: number; skipped: string[] }> {
    const manifest = await this.readManifest();
    let migrated = 0;
    const skipped: string[] = [];
    for (const [id, entry] of Object.entries(manifest.baselines)) {
      if (entry.structure) continue;
      const gz = await readFile(
        path.join(this.legacyDir, `${encodeStoryId(id)}.structure.json.gz`),
      ).catch(() => null);
      if (!gz) continue;
      let snapshot: StructureSnapshot;
      try {
        snapshot = decodeStructure(gz);
      } catch {
        skipped.push(id);
        continue;
      }
      let belongs: boolean;
      if (entry.structureHash !== undefined) {
        belongs = entry.structureHash === snapshot.structureHash;
      } else {
        const image = await readFile(this.legacyImagePath(id)).catch(() => null);
        belongs = image !== null && hashImage(image) === entry.hash;
      }
      if (!belongs) {
        skipped.push(id);
        continue;
      }
      const { structureHash, ...rest } = snapshot;
      manifest.baselines[id] = { ...entry, structureHash, structure: rest };
      migrated++;
    }
    if (migrated > 0) await this.writeManifest(manifest);
    return { migrated, skipped };
  }

  readManifest(): Promise<BaselineManifest> {
    return readManifestFile(this.manifestPath);
  }

  writeManifest(manifest: BaselineManifest): Promise<void> {
    return writeManifestFile(this.manifestPath, manifest);
  }
}
