// `jux snap <url>` — one deterministic capture, pixels plus structure, no
// workbench. The first half of the agent loop: snap before an edit, snap
// after, then `jux diff` (PR b).

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  encodeStructure,
  snapPage,
  type SnapResult,
  type Viewport,
} from '@juxtapose/core';
import { snapName } from '../snap-name.js';

export interface SnapFlags {
  json?: boolean;
  project?: string;
  as?: string;
  viewport?: string;
  'wait-for'?: string;
  mask?: string[];
}

export async function snapCommand(
  url: string | undefined,
  flags: SnapFlags,
): Promise<number> {
  if (!url) {
    process.stderr.write('jux snap: missing <url>\n');
    return 2;
  }
  let viewport: Viewport | undefined;
  if (flags.viewport) {
    const m = /^(\d+)x(\d+)$/.exec(flags.viewport);
    // 0 passes the pattern but Playwright rejects it, which surfaced as exit 1
    // "could not capture" for what is a usage error.
    if (!m || Number(m[1]) === 0 || Number(m[2]) === 0) {
      process.stderr.write(
        `jux snap: --viewport must be WxH, both above 0, got '${flags.viewport}'\n`,
      );
      return 2;
    }
    viewport = { width: Number(m[1]), height: Number(m[2]) };
  }

  const name = snapName(url, flags.as);
  let result: SnapResult;
  try {
    result = await snapPage({
      url,
      ...(viewport ? { viewport } : {}),
      params: {
        ...(flags['wait-for'] ? { waitForSelector: flags['wait-for'] } : {}),
        ...(flags.mask?.length ? { mask: flags.mask } : {}),
      },
    });
  } catch (err) {
    process.stderr.write(
      `jux snap: could not capture ${url}: ${(err as Error).message}\n`,
    );
    return 1;
  }
  if (result.status !== null && (result.status < 200 || result.status >= 300)) {
    process.stderr.write(
      `jux snap: ${url} returned HTTP ${result.status}; nothing written\n`,
    );
    return 1;
  }

  const dir = path.join(
    path.resolve(flags.project ?? process.cwd()),
    '.juxtapose',
    'snaps',
  );
  await mkdir(dir, { recursive: true });
  // Self-ignoring: snaps are scratch, never baselines.
  await writeFile(path.join(dir, '.gitignore'), '*\n');
  const image = path.join(dir, `${name}.webp`);
  await writeFile(image, result.snapshot.image);
  const s = result.snapshot.structure;
  const sidecar = path.join(dir, `${name}.structure.json.gz`);
  // A previous snap's sidecar under this name would otherwise sit beside the
  // new pixels, and a later diff would pair them (Ruling 7, for snaps).
  await rm(sidecar, { force: true });
  const structure = s ? sidecar : null;
  if (s) await writeFile(sidecar, encodeStructure(s));

  const out = {
    name,
    image,
    structure,
    viewport: result.snapshot.viewport,
    env: result.env,
    structureHash: s?.structureHash ?? null,
    elements: s?.elements.length ?? 0,
    durationMs: result.snapshot.durationMs,
  };
  process.stdout.write(
    flags.json
      ? JSON.stringify(out) + '\n'
      : `jux: snapped ${url} → ${name} (${out.elements} elements, ${out.durationMs} ms)\n`,
  );
  return 0;
}
