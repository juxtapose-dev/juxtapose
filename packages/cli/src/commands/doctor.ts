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
  shellQuote,
} from '@juxtapose/core';

const MANIFEST_NAME = 'juxtapose.manifest.json';
import { checkStorage, loadConfig, type CommonFlags } from '../context.js';
import { ignoredCommittedPaths, missingIgnores } from '../gitignore.js';
import { stdio, type Session } from '../io.js';

/** One thing doctor found, with the commands that fix it. */
export interface DoctorIssue {
  code:
    | 'tracked-images'
    | 'legacy-sidecars'
    | 'untracked-images'
    | 'missing-ignores'
    | 'committed-paths-ignored';
  message: string;
  files?: string[];
  fix: string[];
}

/** `storage.dir` may hold `* ? [` and git expands those in a pathspec, so every
 *  git call here reads its paths literally. */
const LITERAL_PATHSPECS = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };

/** A pathspec for the files directly in `dir` ending in `suffix`, for a printed
 *  command: `:(glob)` so `*` means "any name" and the directory's own glob
 *  characters are escaped to mean themselves. */
export function globPathspec(dir: string, suffix: string): string {
  return shellQuote(`:(glob)${dir.replace(/[\\*?[\]]/g, '\\$&')}/*${suffix}`);
}

/** Files shown per issue in text output; --json lists all of them. */
const SHOWN = 5;

/** `*.webp` files under `dir` that git lists, or null when `projectRoot` is
 *  not a repo (nothing to check, which is not a problem). `others` lists the
 *  untracked, not-ignored ones instead of the tracked ones. */
function listedImages(
  projectRoot: string,
  dir: string,
  others: boolean,
  suffix = '.webp',
): string[] | null {
  try {
    const args = [
      'ls-files',
      '-z',
      ...(others ? ['--others', '--exclude-standard'] : []),
    ];
    const out = execFileSync('git', [...args, '--', dir], {
      cwd: projectRoot,
      env: LITERAL_PATHSPECS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter((f) => f.endsWith(suffix));
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * Where the printed commands run. Doctor can be pointed at another project
 * with `--project`, and a command that only works from that directory would
 * silently touch the wrong repo, so from anywhere else they say `git -C`.
 */
function commandsFor(projectRoot: string, cwd: string) {
  const here = path.resolve(cwd) === path.resolve(projectRoot);
  const root = shellQuote(projectRoot);
  return {
    git: (rest: string) => (here ? `git ${rest}` : `git -C ${root} ${rest}`),
    gitignore: here ? '.gitignore' : shellQuote(path.join(projectRoot, '.gitignore')),
    run: (rest: string) => (here ? `jux ${rest}` : `jux ${rest} --project ${root}`),
  };
}

export async function findIssues(
  projectRoot: string,
  storage: Parameters<typeof committedPaths>[0],
  cwd: string = process.cwd(),
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const repoBacked = storage?.kind === 'git' || storage?.kind === 'fs';
  const ignores = ignoredPaths(storage);
  const cmd = commandsFor(projectRoot, cwd);
  // Only what is missing: re-adding a line the file has is noise to review.
  const missing = await missingIgnores(projectRoot, ignores);
  const ignoreFix = (lines: string[]) =>
    `printf '%s\\n' ${lines.map(shellQuote).join(' ')} >> ${cmd.gitignore}`;

  // An explicit repo-backed store tracks its images on purpose. Otherwise both
  // the old layout and the cache dir are places an image must not be tracked.
  if (!repoBacked) {
    const cacheDir =
      (storage?.kind === 'cache' ? storage.dir : undefined) ?? DEFAULT_CACHE_DIR;
    for (const dir of [LEGACY_IMAGE_DIR, cacheDir.replace(/\/+$/, '')]) {
      const files = listedImages(projectRoot, dir, false);
      if (files?.length) {
        issues.push({
          code: 'tracked-images',
          message:
            `${files.length} baseline ${plural(files.length, 'image is', 'images are')} tracked in ${dir}/. ` +
            `juxtapose commits hashes and structure, never images.`,
          files,
          fix: [
            // First, while the files are still on disk: a run copies each image
            // that matches the manifest into the cache, which is the copy that
            // survives once the commit below deletes them from other clones.
            ...(dir === LEGACY_IMAGE_DIR ? [cmd.run('run --all')] : []),
            cmd.git(`rm --cached -- ${globPathspec(dir, '.webp')}`),
            ...(missing.length > 0
              ? [ignoreFix(missing), cmd.git(`add -- ${shellQuote('.gitignore')}`)]
              : []),
            cmd.git(`commit -m ${shellQuote('Stop tracking juxtapose baseline images')}`),
          ],
        });
      }
      if (dir === LEGACY_IMAGE_DIR) {
        const sidecars = listedImages(projectRoot, dir, false, '.structure.json.gz');
        if (sidecars?.length) {
          issues.push({
            code: 'legacy-sidecars',
            message:
              `${sidecars.length} legacy structure ${plural(sidecars.length, 'file is', 'files are')} tracked in ${dir}/. ` +
              `Structure now lives in ${MANIFEST_NAME}.`,
            files: sidecars,
            fix: [
              // A run folds each passing story's structure into the manifest,
              // and an approve does it for the rest; untrack only after.
              cmd.run('run --all'),
              cmd.run('approve --all'),
              cmd.git(`rm --cached -- ${globPathspec(dir, '.structure.json.gz')}`),
              cmd.git(`add -- ${shellQuote(MANIFEST_NAME)}`),
              cmd.git(
                `commit -m ${shellQuote('Move juxtapose structure into the manifest')}`,
              ),
            ],
          });
        }
      }
      const loose = listedImages(projectRoot, dir, true);
      if (loose?.length) {
        issues.push({
          code: 'untracked-images',
          message:
            `${loose.length} baseline ${plural(loose.length, 'image in', 'images in')} ${dir}/ ` +
            `${plural(loose.length, 'is', 'are')} neither tracked nor ignored, so the next \`git add .\` commits them.`,
          files: loose,
          fix: [ignoreFix(missing.length > 0 ? missing : ignores)],
        });
      }
    }
  }

  // An earlier issue's fix already appends them: one place to run it, not two.
  const ignoreInFix = issues.some((i) =>
    i.fix.some((l) => l.includes(`>> ${cmd.gitignore}`)),
  );
  if (missing.length > 0 && !ignoreInFix) {
    issues.push({
      code: 'missing-ignores',
      message: `.gitignore does not cover ${missing.join(', ')}.`,
      fix: [ignoreFix(missing)],
    });
  }

  // The files jux needs committed must not be ignored: `git add` would skip
  // them silently. The patterns that do it are the user's, so the fix is theirs.
  const hidden = ignoredCommittedPaths(projectRoot);
  if (hidden.length > 0) {
    issues.push({
      code: 'committed-paths-ignored',
      message:
        `.gitignore ignores ${hidden.map((h) => h.path).join(' and ')}, which juxtapose commits, ` +
        `so \`git add\` skips ${hidden.length === 1 ? 'it' : 'them'}. ` +
        `Edit the pattern that matches (${hidden[0]?.source ?? 'unknown'}${hidden[0]?.pattern ? `: ${hidden[0].pattern}` : ''}) by hand.`,
      fix: [],
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
  checkStorage(config);
  const issues = await findIssues(projectRoot, config.storage);

  if (flags.json === true) {
    io.out(JSON.stringify({ ok: issues.length === 0, issues }) + '\n');
    return issues.length === 0 ? 0 : 1;
  }

  if (issues.length === 0) {
    const kind = config.storage?.kind;
    io.out(
      kind === 'git' || kind === 'fs'
        ? 'jux doctor: ok. This project commits its images on purpose (storage.kind is set).\n'
        : 'jux doctor: ok. No snapshot images are tracked, and .gitignore covers them.\n',
    );
    return 0;
  }

  for (const issue of issues) {
    io.out(`\n  ! ${issue.message}\n`);
    for (const f of issue.files?.slice(0, SHOWN) ?? []) io.out(`      ${f}\n`);
    if ((issue.files?.length ?? 0) > SHOWN) {
      io.out(`      …and ${issue.files!.length - SHOWN} more\n`);
    }
    if (issue.fix.length > 0) io.out('    Fix:\n');
    for (const line of issue.fix) io.out(`      ${line}\n`);
    if (issue.code === 'tracked-images') {
      io.out(
        '    Run the first step before the commit. Once the commit lands, git deletes the\n' +
          '    images from every clone that pulls it. The run copies each image that matches\n' +
          '    the manifest into your cache, but teammates and CI start with an empty one and\n' +
          '    get structure-only reports until their own run, or a restored CI cache\n' +
          '    (docs/ci.md), fills it. Structure now lives in the manifest.\n' +
          `    From now on commit ${committedPaths(undefined).map(shellQuote).join(' and ')}.\n`,
      );
    }
  }
  io.out('\n');
  return 1;
}
