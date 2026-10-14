// Cache-backed baseline store — the default.
//
// A project commits hashes and metadata, never pixels:
//   - `juxtapose.manifest.json`: the per-story hash. This alone decides
//     pass/fail, so CI needs no image to detect a change.
//   - `.juxtapose/structure/<id>.structure.json`: the per-story structure
//     sidecar, so CI can also say which elements changed without an image.
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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalMeta,
  BaselineImageLookup,
  BaselineManifest,
  BaselineStore,
} from '../types.js';
import { encodeStoryId } from './git-store.js';
import {
  MANIFEST_NAME,
  readManifestFile,
  readManifestFileSync,
  writeManifestFile,
} from './manifest-file.js';
import { hashImage } from './status.js';

export const DEFAULT_CACHE_DIR = '.juxtapose/cache/baselines';
export const STRUCTURE_DIR = '.juxtapose/structure';
/** Where the repo-backed store kept images. Read-only here, so a project that
 *  upgrades keeps its diffs until it migrates. */
export const LEGACY_IMAGE_DIR = '.juxtapose/baselines';

export interface CacheStoreOptions {
  projectRoot: string;
  /** Image cache, relative to projectRoot. Default `.juxtapose/cache/baselines`. */
  dir?: string;
}

export class CacheBaselineStore implements BaselineStore {
  private readonly cacheDir: string;
  private readonly structureDir: string;
  private readonly legacyDir: string;
  private readonly manifestPath: string;

  constructor(opts: CacheStoreOptions) {
    this.cacheDir = path.join(opts.projectRoot, opts.dir ?? DEFAULT_CACHE_DIR);
    this.structureDir = path.join(opts.projectRoot, STRUCTURE_DIR);
    this.legacyDir = path.join(opts.projectRoot, LEGACY_IMAGE_DIR);
    this.manifestPath = path.join(opts.projectRoot, MANIFEST_NAME);
  }

  private cachePath(hash: string): string {
    return path.join(this.cacheDir, `${hash}.webp`);
  }

  private legacyImagePath(storyId: string): string {
    return path.join(this.legacyDir, `${encodeStoryId(storyId)}.webp`);
  }

  private structurePath(storyId: string): string {
    return path.join(this.structureDir, `${encodeStoryId(storyId)}.structure.json`);
  }

  async lookup(storyId: string): Promise<BaselineImageLookup> {
    const entry = (await this.readManifest()).baselines[storyId];
    if (!entry) return { kind: 'unavailable', reason: 'no-manifest-entry' };
    // A cache file is trusted only if its bytes still hash to its name: a
    // truncated restore or a hand-edit must read as "not there", never as the
    // baseline the manifest approved.
    for (const file of [this.cachePath(entry.hash), this.legacyImagePath(storyId)]) {
      const bytes = await readFile(file).catch(() => null);
      if (bytes && hashImage(bytes) === entry.hash)
        return { kind: 'found', image: bytes };
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
    if (hash === undefined) return undefined;
    for (const file of [this.cachePath(hash), this.legacyImagePath(storyId)]) {
      try {
        if (hashImage(readFileSync(file)) === hash) return file;
      } catch {
        // not there
      }
    }
    return undefined;
  }

  async put(storyId: string, image: Buffer, meta: ApprovalMeta): Promise<void> {
    const hash = createHash('sha256').update(image).digest('hex');
    const file = this.cachePath(hash);
    if (!existsSync(file)) {
      await mkdir(this.cacheDir, { recursive: true });
      // Write-then-rename: a reader (or a CI cache save) never sees half an image
      // under a name that promises its hash.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, image);
      await rename(tmp, file);
    }
    // A previous baseline's sidecar must not outlive its pixels: a capture
    // approved without structure would otherwise inherit the old one.
    await rm(this.structurePath(storyId), { force: true });

    const manifest = await this.readManifest();
    manifest.baselines[storyId] = { ...meta, hash };
    await this.writeManifest(manifest);
  }

  async remove(storyId: string): Promise<void> {
    // The image stays: it is named by content, so another story or another
    // commit's manifest may still point at it.
    await rm(this.structurePath(storyId), { force: true });
    const manifest = await this.readManifest();
    delete manifest.baselines[storyId];
    await this.writeManifest(manifest);
  }

  async putStructure(storyId: string, structure: Buffer): Promise<void> {
    await mkdir(this.structureDir, { recursive: true });
    await writeFile(this.structurePath(storyId), structure);
  }

  async getStructure(storyId: string): Promise<Buffer | null> {
    for (const file of [
      this.structurePath(storyId),
      // Old layout: gzip beside the image.
      path.join(this.legacyDir, `${encodeStoryId(storyId)}.structure.json.gz`),
    ]) {
      const bytes = await readFile(file).catch(() => null);
      if (bytes) return bytes;
    }
    return null;
  }

  readManifest(): Promise<BaselineManifest> {
    return readManifestFile(this.manifestPath);
  }

  writeManifest(manifest: BaselineManifest): Promise<void> {
    return writeManifestFile(this.manifestPath, manifest);
  }
}
