// Resolve the ambient stuff every command needs: where the project is, which
// workbench it uses, where baselines live.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { BaselineStore, Platform, ProjectConfig } from '@juxtapose/core';
import { GitBaselineStore, createUrlPlatform } from '@juxtapose/core';
import { StorybookPlatform } from '@juxtapose/adapter-storybook';
import { LadlePlatform } from '@juxtapose/adapter-ladle';

export interface CommonFlags {
  json?: boolean;
  project?: string;
  'build-dir'?: string;
  origin?: string;
  platform?: string;
  concurrency?: string;
  since?: string;
  all?: boolean;
  story?: string[];
  run?: string;
  comment?: boolean;
  html?: boolean;
  chrome?: string;
  /** `--no-daemon`: same as JUX_NO_DAEMON=1. */
  'no-daemon'?: boolean;
}

export interface Context {
  projectRoot: string;
  config: ProjectConfig;
  platform: Platform;
  store: BaselineStore;
  buildDir?: string;
  origin?: string;
  json: boolean;
}

/** Candidate build outputs, in the order we'd expect to find them. */
const BUILD_DIR_CANDIDATES = [
  'storybook-static',
  'build',
  '.ladle/build',
  'dist/storybook',
];

export async function resolveContext(flags: CommonFlags): Promise<Context> {
  const projectRoot = path.resolve(flags.project ?? process.cwd());
  const fileConfig = await loadConfig(projectRoot);

  const config: ProjectConfig = {
    ...fileConfig,
    ...(flags.concurrency ? { concurrency: Number(flags.concurrency) } : {}),
    ...(flags.origin ? { origin: flags.origin } : {}),
  };

  const origin = flags.origin ?? config.origin;
  const buildDir = resolveBuildDir(
    projectRoot,
    flags['build-dir'] ?? config.buildDir,
    origin,
  );

  const target = { projectRoot, buildDir, origin };
  const platform = await resolvePlatform(
    flags.platform ?? config.platform,
    target,
    config,
  );

  return {
    projectRoot,
    config,
    platform,
    store: createStore(projectRoot, config),
    buildDir,
    origin,
    json: flags.json === true,
  };
}

function resolveBuildDir(
  projectRoot: string,
  explicit: string | undefined,
  origin: string | undefined,
): string | undefined {
  if (explicit) return path.resolve(projectRoot, explicit);
  // A dev-server origin means there's nothing built to point at.
  if (origin) return undefined;

  for (const candidate of BUILD_DIR_CANDIDATES) {
    const abs = path.join(projectRoot, candidate);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

async function resolvePlatform(
  name: string | undefined,
  target: { projectRoot: string; buildDir?: string; origin?: string },
  config: ProjectConfig,
): Promise<Platform> {
  if (name === 'urls') {
    if (!config.urls?.length) {
      throw new Error(
        "platform 'urls' needs a non-empty `urls` list in juxtapose config",
      );
    }
    return createUrlPlatform(config.urls);
  }
  const platforms: Platform[] = [new StorybookPlatform(), new LadlePlatform()];

  if (name) {
    const found = platforms.find((p) => p.name === name);
    if (!found) {
      throw new Error(
        `unknown platform '${name}' (expected: ${[...platforms.map((p) => p.name), 'urls'].join(', ')})`,
      );
    }
    return found;
  }

  for (const platform of platforms) {
    if (await platform.detect(target)) return platform;
  }

  throw new Error(
    `could not detect a workbench at ${target.origin ?? target.buildDir ?? target.projectRoot}.\n` +
      `Build Storybook or Ladle first, pass --build-dir, or point --origin at a dev server.`,
  );
}

function createStore(projectRoot: string, config: ProjectConfig): BaselineStore {
  const storage = config.storage ?? { kind: 'git' as const };
  switch (storage.kind) {
    case 'git':
      return new GitBaselineStore({ projectRoot, dir: storage.dir });
    case 'fs':
      return new GitBaselineStore({ projectRoot, dir: storage.dir });
    case 's3':
      throw new Error(
        'the s3 baseline store is not implemented yet; use the default git store',
      );
  }
}

/**
 * The user's config, as written. Kept as casts: each setting is checked where
 * it is used (resolveSnapSlots takes `unknown`), and a schema check here would
 * reject configs that work today, which is a change of its own.
 */
export async function loadConfig(projectRoot: string): Promise<ProjectConfig> {
  for (const name of ['juxtapose.config.json', '.juxtaposerc.json']) {
    try {
      return JSON.parse(
        await readFile(path.join(projectRoot, name), 'utf8'),
      ) as ProjectConfig;
    } catch {
      // try next
    }
  }

  try {
    const pkg = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { juxtapose?: ProjectConfig };
    if (pkg.juxtapose) return pkg.juxtapose;
  } catch {
    // no package.json, or unreadable
  }

  return {};
}

export function gitBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? 'unknown';
}

export function gitSha(cwd: string): string {
  return git(['rev-parse', 'HEAD'], cwd) ?? 'unknown';
}

export function isGitRepo(cwd: string): boolean {
  return git(['rev-parse', '--git-dir'], cwd) !== null;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
