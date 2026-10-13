// `jux init` — nothing to a working setup in one command.
//
// The first run without this is: run, discover everything is "new", work out
// that you need to approve, then remember to commit two paths you were never
// told about. Each step is obvious in hindsight and opaque the first time.
//
// This does the same work but narrates it, and ends by telling you exactly
// what to commit.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  approveCapture,
  acquireBrowser,
  installChrome,
  resolveChrome,
  encodeStoryId,
  runCapture,
  alwaysAncestor,
  createAncestryCheck,
  type ProjectConfig,
  type RunArtifact,
} from '@juxtapose/core';
import {
  resolveContext,
  gitBranch,
  gitSha,
  isGitRepo,
  type CommonFlags,
} from '../context.js';
import { serveStatic } from '../serve-static.js';
import { EXIT } from '../exit-codes.js';
import { installWithProxy } from './browser.js';

const CONFIG_NAME = 'juxtapose.config.json';

export async function initCommand(flags: CommonFlags): Promise<number> {
  const ctx = await resolveContext(flags);
  const say = (msg: string) => {
    if (!ctx.json) process.stdout.write(msg + '\n');
  };

  if (ctx.platform.name === 'urls') {
    process.stderr.write(
      "jux: init doesn't apply to platform 'urls'; list pages under `urls` in your config and run `jux run`.\n",
    );
    return 2;
  }

  const configPath = path.join(ctx.projectRoot, CONFIG_NAME);
  const alreadyConfigured = existsSync(configPath);

  const stories = await ctx.platform.enumerate({
    projectRoot: ctx.projectRoot,
    buildDir: ctx.buildDir,
    origin: ctx.origin,
  });

  if (stories.length === 0) {
    process.stderr.write(
      `jux: found a ${ctx.platform.name} build but no stories in it.\n`,
    );
    return 1;
  }

  say(
    `Found ${stories.length} ${plural(stories.length, 'story', 'stories')} in your ${ctx.platform.name} build.`,
  );

  // Write the config before capturing: if the capture fails halfway, the user
  // still has something to edit and re-run rather than starting over.
  if (alreadyConfigured) {
    say(`Keeping your existing ${CONFIG_NAME}.`);
  } else {
    await writeFile(configPath, JSON.stringify(defaultConfig(ctx), null, 2) + '\n');
    say(`Wrote ${CONFIG_NAME}.`);
  }

  const server = ctx.origin ? null : await serveStatic(ctx.buildDir!);
  const baseUrl = ctx.origin ?? server!.url;
  let browser;
  try {
    if (!resolveChrome({ flag: flags.chrome })) {
      // Same path as `jux browser install`: proxy re-exec, and a stderr line
      // before the download (never silent, even with --json or in CI).
      const out = await installWithProxy(
        {
          env: process.env,
          writeErr: (s) => process.stderr.write(s),
          install: installChrome,
          // The child's stdout is the install report; init's stdout stays its own.
          spawn: (cmd, args, env) =>
            spawnSync(cmd, args, { stdio: ['ignore', 2, 'inherit'], env }),
          argv: [process.argv[1], 'browser', 'install'],
        },
        { force: false, json: flags.json === true },
      );
      if ('code' in out && out.code !== EXIT.clean)
        throw new Error('jux: the browser install failed (see above).');
    }
    browser = await acquireBrowser({
      chrome: flags.chrome,
      noDaemon: flags['no-daemon'] === true,
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    await server?.close();
    return EXIT.failure;
  }

  const runId = Date.now().toString(36);
  const runDir = path.join(ctx.projectRoot, '.juxtapose', 'runs', runId);
  try {
    // Inside the try, so a failed mkdir still closes the browser below.
    await mkdir(path.join(runDir, 'images'), { recursive: true });
    say('Capturing…');

    const report = await runCapture({
      browser,
      platform: ctx.platform,
      store: ctx.store,
      baseUrl,
      stories,
      totalCount: stories.length,
      config: ctx.config,
      ancestry: isGitRepo(ctx.projectRoot)
        ? createAncestryCheck(ctx.projectRoot)
        : alwaysAncestor,
      runId,
      branch: gitBranch(ctx.projectRoot),
      commitSha: gitSha(ctx.projectRoot),
      onArtifact: (a) => writeArtifact(runDir, a),
      onProgress: (done, total) => {
        // Pad to a fixed width so a shorter line never leaves characters
        // from the previous, longer one behind.
        if (!ctx.json) {
          process.stdout.write(`
  ${`${done}/${total} captured`.padEnd(30)}`);
        }
      },
    });

    // End the progress line with a newline rather than erasing it. A bare
    // carriage return leaves the counter sitting on the same row as whatever
    // prints next, which is how "16/16 captured" ended up welded to
    // "Approved 14 baselines."
    if (!ctx.json) process.stdout.write('\n');

    // Everything is `new` on a first run, which is exactly what we want to
    // approve. A story that fails here had no baseline to fail against, so it
    // is a capture error rather than a visual change.
    const capturable = report.results.filter((r) => r.status !== 'skip');
    const failed = report.results.filter((r) => r.status === 'fail');

    const commit = gitSha(ctx.projectRoot);
    const approvedBy = process.env.JUXTAPOSE_USER ?? process.env.USER ?? 'unknown';
    const approvedAt = new Date().toISOString();

    let approved = 0;
    for (const result of capturable) {
      if (result.status === 'fail') continue;
      const imagePath = capturePath(runDir, result.storyId);
      const image = await readFile(imagePath).catch(() => null);
      if (!image) continue;
      const { structureError } = await approveCapture(
        ctx.store,
        result.storyId,
        image,
        { commit, approvedBy, approvedAt, env: report.env },
        imagePath,
      );
      if (structureError) {
        process.stderr.write(
          `jux: approved ${result.storyId}, but its structure was not saved: ${structureError}\n`,
        );
      }
      approved++;
    }

    if (ctx.json) {
      process.stdout.write(
        JSON.stringify({
          platform: ctx.platform.name,
          stories: stories.length,
          approved,
          failed: failed.length,
          config: alreadyConfigured ? null : CONFIG_NAME,
        }) + '\n',
      );
      return failed.length > 0 ? 1 : 0;
    }

    say(`Approved ${approved} ${plural(approved, 'baseline', 'baselines')}.`);

    if (failed.length > 0) {
      say('');
      say(
        `${failed.length} ${plural(failed.length, 'story', 'stories')} could not be captured:`,
      );
      for (const f of failed.slice(0, 5)) {
        say(`  ${f.storyId}${f.error ? ` — ${f.error}` : ''}`);
      }
      say('');
      say('These have no baseline. Fix them, then run `jux run` again.');
    }

    say('');
    say('Commit the baselines so everyone compares against the same thing:');
    say('');
    say(`  git add ${CONFIG_NAME} juxtapose.manifest.json .juxtapose/baselines`);
    say(`  git commit -m "Add juxtapose visual baselines"`);
    say('');
    say('From now on `jux run` captures only what your changes could affect.');

    return failed.length > 0 ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
    await server?.close();
  }
}

/**
 * A config with only what we actually detected.
 *
 * Deliberately minimal: every key written here is one the user has to
 * understand later when it stops matching their project. Defaults that live in
 * code can change with the tool; defaults frozen into a config file cannot.
 */
function defaultConfig(ctx: {
  platform: { name: string };
  buildDir?: string;
  projectRoot: string;
}): ProjectConfig {
  const config: ProjectConfig = {
    platform: ctx.platform.name as ProjectConfig['platform'],
  };
  if (ctx.buildDir) {
    config.buildDir = path.relative(ctx.projectRoot, ctx.buildDir) || '.';
  }
  return config;
}

async function writeArtifact(runDir: string, a: RunArtifact): Promise<void> {
  const safe = encodeStoryId(a.storyId);
  await writeFile(path.join(runDir, 'images', `${safe}-current.webp`), a.current);
}

const capturePath = (runDir: string, storyId: string) =>
  path.join(runDir, 'images', `${encodeStoryId(storyId)}-current.webp`);

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
