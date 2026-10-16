// Repo-backed baseline store — images committed beside the manifest.
//
// Baselines are WebP files committed under .juxtapose/baselines/. This was the
// default until the cache store (cache-store.ts) replaced it: every approval
// added binary history to the repo for good. It stays for projects that set
// `storage.kind: "git"` (or "fs") and want pixels in the repo regardless.
//
// Three properties fall out of this that a bucket does not give you:
//   - Approving a baseline is a reviewable diff in the PR that changed it.
//   - Branches get correct baselines by construction: checking out a branch
//     checks out its baselines. No branch-keyed prefixes, no fallback-to-main.
//   - Reverting a bad approval is `git revert`.
//
// The cost is repo size. WebP at quality 90 keeps a 1280x800 story around
// 30-60KB; a 700-story suite is tens of megabytes.

import { readStructureFile, writeStructureFile } from './structure-file.js';
import { batchManifest } from './manifest-batch.js';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import type { ApprovalMeta, BaselineManifest, BaselineStore } from '../types.js';
import { hashImage } from './status.js';
import { decodeStructure, isGzip } from '../capture/structure.js';
import { MANIFEST_NAME, readManifestFile, writeManifestFile } from './manifest-file.js';

/**
 * Readable JSON back to the bytes this layout has always committed (compact
 * JSON, gzipped). Re-approving a story must not rewrite its committed sidecar
 * with different bytes for the same structure.
 */
function compactGzip(readable: Buffer): Buffer {
  try {
    return gzipSync(Buffer.from(JSON.stringify(JSON.parse(readable.toString('utf8')))));
  } catch {
    // Not JSON: a store holds whatever it is handed; readers reject it later.
    return gzipSync(readable);
  }
}

export interface GitStoreOptions {
  projectRoot: string;
  /** Where baseline images live, relative to projectRoot. */
  dir?: string;
}

export class GitBaselineStore implements BaselineStore {
  private readonly imageDir: string;
  private readonly manifestPath: string;

  constructor(private readonly opts: GitStoreOptions) {
    this.imageDir = path.join(opts.projectRoot, opts.dir ?? '.juxtapose/baselines');
    this.manifestPath = path.join(opts.projectRoot, MANIFEST_NAME);
  }

  async batch(action: (store: BaselineStore) => Promise<void>): Promise<void> {
    await batchManifest(new GitBaselineStore(this.opts), action);
  }

  private imagePath(storyId: string): string {
    return path.join(this.imageDir, `${encodeStoryId(storyId)}.webp`);
  }

  private structurePath(storyId: string): string {
    return path.join(this.imageDir, `${encodeStoryId(storyId)}.structure.json.gz`);
  }

  locate(storyId: string): string {
    return this.imagePath(storyId);
  }

  async putStructure(storyId: string, bytes: Buffer): Promise<void> {
    const manifest = await this.readManifest();
    const entry = manifest.baselines[storyId];
    // Preserve the standalone legacy sidecar API for callers without an entry.
    if (!entry) {
      await mkdir(this.imageDir, { recursive: true });
      await writeFile(
        this.structurePath(storyId),
        isGzip(bytes) ? bytes : compactGzip(bytes),
      );
      return;
    }
    let snapshot;
    try {
      snapshot = decodeStructure(bytes);
    } catch {
      // Preserve the legacy store's opaque-sidecar contract for custom callers.
      await mkdir(this.imageDir, { recursive: true });
      await writeFile(
        this.structurePath(storyId),
        isGzip(bytes) ? bytes : compactGzip(bytes),
      );
      return;
    }
    const reference = await writeStructureFile(this.opts.projectRoot, storyId, snapshot);
    const { structure: _oldStructure, ...meta } = entry;
    manifest.baselines[storyId] = {
      ...meta,
      structureHash: snapshot.structureHash,
      ...reference,
    };
    await this.writeManifest(manifest);
  }

  async getStructure(storyId: string): Promise<Buffer | null> {
    const entry = (await this.readManifest()).baselines[storyId];
    if (entry?.structure)
      return Buffer.from(
        JSON.stringify({ ...entry.structure, structureHash: entry.structureHash }),
      );
    if (entry?.structureFile)
      return readStructureFile(this.opts.projectRoot, storyId, entry);
    try {
      return await readFile(this.structurePath(storyId));
    } catch {
      return null;
    }
  }

  async get(storyId: string): Promise<Buffer | null> {
    try {
      return await readFile(this.imagePath(storyId));
    } catch {
      return null;
    }
  }

  async put(storyId: string, image: Buffer, meta: ApprovalMeta): Promise<void> {
    await mkdir(this.imageDir, { recursive: true });
    // A previous baseline's sidecar must not outlive its pixels: a capture
    // approved without structure would otherwise inherit the old one.
    await rm(this.structurePath(storyId), { force: true });
    await writeFile(this.imagePath(storyId), image);

    const manifest = await this.readManifest();
    manifest.baselines[storyId] = { ...meta, hash: hashImage(image) };
    await this.writeManifest(manifest);
  }

  async remove(storyId: string): Promise<void> {
    await rm(this.imagePath(storyId), { force: true });
    await rm(this.structurePath(storyId), { force: true });
    const manifest = await this.readManifest();
    delete manifest.baselines[storyId];
    await this.writeManifest(manifest);
  }

  readManifest(): Promise<BaselineManifest> {
    return readManifestFile(this.manifestPath);
  }

  writeManifest(manifest: BaselineManifest): Promise<void> {
    return writeManifestFile(this.manifestPath, manifest);
  }
}

/**
 * Make a story id safe as a single path segment.
 *
 * Story ids come from the platform and are usually kebab-case, but that is an
 * assumption, not a guarantee — the original tool interpolated them raw into
 * S3 keys and file paths. A `/` or `..` in an id would escape the baseline
 * directory, so encode anything outside a conservative allowlist.
 */
export function encodeStoryId(storyId: string): string {
  // `.` is deliberately NOT in the allowlist. Escaping only separators would
  // leave `..` intact, which cannot traverse without a `/` but still yields
  // filenames that read as relative paths — a trap for anything downstream
  // that joins, splits, or normalizes them. Encoding every dot makes the
  // result inert by construction rather than by argument.
  return storyId.replace(
    /[^a-zA-Z0-9_-]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'),
  );
}
