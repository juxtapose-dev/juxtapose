// Git-backed baseline store — the default.
//
// Baselines are WebP files committed under .juxtapose/baselines/. No bucket to
// provision, no credentials, and the tool does something useful the moment it
// is installed.
//
// Three properties fall out of this that a bucket does not give you:
//   - Approving a baseline is a reviewable diff in the PR that changed it.
//   - Branches get correct baselines by construction: checking out a branch
//     checks out its baselines. No branch-keyed prefixes, no fallback-to-main.
//   - Reverting a bad approval is `git revert`.
//
// The cost is repo size. WebP at quality 90 keeps a 1280x800 story around
// 30-60KB; a 700-story suite is tens of megabytes. Real, but tolerable, and
// the S3 store exists for suites where it isn't.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ApprovalMeta, BaselineManifest, BaselineStore } from '../types.js';
import { hashImage } from './status.js';

const MANIFEST_NAME = 'juxtapose.manifest.json';
const EMPTY: BaselineManifest = { version: 1, baselines: {} };

export interface GitStoreOptions {
  projectRoot: string;
  /** Where baseline images live, relative to projectRoot. */
  dir?: string;
}

export class GitBaselineStore implements BaselineStore {
  private readonly imageDir: string;
  private readonly manifestPath: string;

  constructor(opts: GitStoreOptions) {
    this.imageDir = path.join(opts.projectRoot, opts.dir ?? '.juxtapose/baselines');
    this.manifestPath = path.join(opts.projectRoot, MANIFEST_NAME);
  }

  private imagePath(storyId: string): string {
    return path.join(this.imageDir, `${encodeStoryId(storyId)}.webp`);
  }

  private structurePath(storyId: string): string {
    return path.join(this.imageDir, `${encodeStoryId(storyId)}.structure.json.gz`);
  }

  async putStructure(storyId: string, gz: Buffer): Promise<void> {
    await mkdir(this.imageDir, { recursive: true });
    await writeFile(this.structurePath(storyId), gz);
  }

  async getStructure(storyId: string): Promise<Buffer | null> {
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

  async readManifest(): Promise<BaselineManifest> {
    if (!existsSync(this.manifestPath)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(
        await readFile(this.manifestPath, 'utf8'),
      ) as BaselineManifest;
      if (parsed?.version !== 1 || typeof parsed.baselines !== 'object') {
        return structuredClone(EMPTY);
      }
      return parsed;
    } catch {
      // A corrupt manifest means every story reads as `new`, which is loud and
      // recoverable. Throwing here would block the run entirely.
      return structuredClone(EMPTY);
    }
  }

  async writeManifest(manifest: BaselineManifest): Promise<void> {
    // Sort keys so the committed file produces a minimal, readable git diff —
    // the whole point of storing baselines in the repo.
    const sorted: BaselineManifest = { version: 1, baselines: {} };
    for (const id of Object.keys(manifest.baselines).sort()) {
      sorted.baselines[id] = manifest.baselines[id];
    }
    await writeFile(this.manifestPath, JSON.stringify(sorted, null, 2) + '\n');
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
