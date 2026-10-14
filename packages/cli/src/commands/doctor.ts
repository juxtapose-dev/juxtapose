// `jux doctor` — check a project against the rule that it commits hashes and
// metadata, never snapshot images.
//
// It reads the repo and the config only: no workbench, no browser, so it runs
// anywhere, including a CI step that guards against images creeping back in.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  DEFAULT_CACHE_DIR,
  LEGACY_IMAGE_DIR,
  committedPaths,
  ignoredPaths,
} from '@juxtapose/core';
import { loadConfig, type CommonFlags } from '../context.js';
import { missingIgnores } from '../gitignore.js';
import { stdio, type Session } from '../io.js';

/** One thing doctor found, with the commands that fix it. */
export interface DoctorIssue {
  code: 'tracked-images' | 'missing-ignores';
  message: string;
  files?: string[];
  fix: string[];
}

/** Files shown per issue in text output; --json lists all of them. */
const SHOWN = 5;

/** Tracked `*.webp` files under `dir`, or null when `projectRoot` is not a
 *  repo (nothing to check, which is not a problem). */
function trackedImages(projectRoot: string, dir: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', dir], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter((f) => f.endsWith('.webp'));
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export async function findIssues(
  projectRoot: string,
  storage: Parameters<typeof committedPaths>[0],
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const repoBacked = storage?.kind === 'git' || storage?.kind === 'fs';
  const ignores = ignoredPaths(storage);

  // An explicit repo-backed store tracks its images on purpose. Otherwise both
  // the old layout and the cache dir are places an image must not be tracked.
  if (!repoBacked) {
    const cacheDir =
      (storage?.kind === 'cache' ? storage.dir : undefined) ?? DEFAULT_CACHE_DIR;
    for (const dir of [LEGACY_IMAGE_DIR, cacheDir.replace(/\/+$/, '')]) {
      const files = trackedImages(projectRoot, dir);
      if (!files?.length) continue;
      issues.push({
        code: 'tracked-images',
        message:
          `${files.length} baseline ${plural(files.length, 'image is', 'images are')} tracked in ${dir}/. ` +
          `juxtapose commits hashes and structure, never images.`,
        files,
        fix: [
          `git rm --cached -- '${dir}/*.webp'`,
          `git commit -m "Stop tracking juxtapose baseline images"`,
        ],
      });
    }
  }

  const missing = await missingIgnores(projectRoot, ignores);
  if (missing.length > 0) {
    issues.push({
      code: 'missing-ignores',
      message: `.gitignore does not cover ${missing.join(', ')}.`,
      fix: [`printf '%s\\n' ${missing.map((m) => `'${m}'`).join(' ')} >> .gitignore`],
    });
  }
  return issues;
}

export async function doctorCommand(
  flags: CommonFlags,
  { io = stdio }: Session = {},
): Promise<number> {
  const projectRoot = path.resolve(flags.project ?? process.cwd());
  const config = await loadConfig(projectRoot);
  const issues = await findIssues(projectRoot, config.storage);

  if (flags.json === true) {
    io.out(JSON.stringify({ ok: issues.length === 0, issues }) + '\n');
    return issues.length === 0 ? 0 : 1;
  }

  if (issues.length === 0) {
    io.out(
      'jux doctor: ok. No snapshot images are tracked, and .gitignore covers them.\n',
    );
    return 0;
  }

  for (const issue of issues) {
    io.out(`\n  ! ${issue.message}\n`);
    for (const f of issue.files?.slice(0, SHOWN) ?? []) io.out(`      ${f}\n`);
    if ((issue.files?.length ?? 0) > SHOWN) {
      io.out(`      …and ${issue.files!.length - SHOWN} more\n`);
    }
    io.out('    Fix:\n');
    for (const line of issue.fix) io.out(`      ${line}\n`);
    if (issue.code === 'tracked-images') {
      io.out(
        '    The files stay on disk, and jux keeps reading them until the cache has the\n' +
          '    same images, so no diff goes blank. Structure sidecars (.structure.json.gz)\n' +
          '    can stay tracked; new approvals write them to .juxtapose/structure/.\n' +
          `    From now on commit ${committedPaths(undefined).join(' and ')}.\n`,
      );
    }
  }
  io.out('\n');
  return 1;
}
