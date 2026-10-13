// `jux snap <url>…` — deterministic captures, pixels plus structure, no
// workbench. The first half of the agent loop: snap before an edit, snap
// after, then `jux diff`. Several URLs share one browser launch so an agent
// can snap every page a shared component touches in one command.
//
// Exit 0 every page written, 2 usage, 3 the browser or any page failed. When
// one page of several fails the rest are still captured and written, the
// failed one is reported (with its error, in --json too) and the exit is 3:
// the agent asked for all of them, so a partial set must not look like success.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  encodeStructure,
  snapPages,
  type CaptureEnv,
  type SnapPageResult,
  type Viewport,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
import { snapName } from '../snap-name.js';
import { snapsDir } from '../snaps-dir.js';

export interface SnapFlags {
  json?: boolean;
  project?: string;
  as?: string;
  'as-prefix'?: string;
  viewport?: string;
  'wait-for'?: string;
  mask?: string[];
}

interface Written {
  url: string;
  name: string;
  image: string;
  structure: string | null;
  viewport: Viewport;
  env: CaptureEnv;
  structureHash: string | null;
  elements: number;
  durationMs: number;
}

export async function snapCommand(urls: string[], flags: SnapFlags): Promise<number> {
  if (urls.length === 0) {
    process.stderr.write(
      'jux snap: missing <url>. Try `jux snap http://localhost:5173 --as before`.\n',
    );
    return EXIT.usage;
  }
  if (urls.length > 1 && flags.as) {
    process.stderr.write(
      'jux snap: --as names one snap; for several urls use --as-prefix <p> (snaps are named <p>-<slug>).\n',
    );
    return EXIT.usage;
  }
  if (flags.as && flags['as-prefix']) {
    process.stderr.write('jux snap: use --as or --as-prefix, not both.\n');
    return EXIT.usage;
  }
  let viewport: Viewport | undefined;
  if (flags.viewport) {
    const m = /^(\d+)x(\d+)$/.exec(flags.viewport);
    // 0 passes the pattern but Playwright rejects it, which surfaced as exit 1
    // "could not capture" for what is a usage error.
    if (!m || Number(m[1]) === 0 || Number(m[2]) === 0) {
      process.stderr.write(
        `jux snap: --viewport must be WxH, both above 0, got '${flags.viewport}'. Try --viewport 1280x800.\n`,
      );
      return EXIT.usage;
    }
    viewport = { width: Number(m[1]), height: Number(m[2]) };
  }

  const prefix = flags['as-prefix']
    ? snapName(flags['as-prefix'], flags['as-prefix'])
    : undefined;
  const nameOf = (url: string) =>
    prefix ? `${prefix}-${snapName(url)}` : snapName(url, flags.as);

  // Validate every url before launching anything: a bad argument is a usage
  // error, and names derive from host + path, so two urls differing only by
  // query would silently overwrite each other.
  const seen = new Map<string, string>();
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      process.stderr.write(
        `jux snap: '${url}' is not an http(s) URL. Serve the page (e.g. \`vite\`) and run \`jux snap http://localhost:<port>/ --as <name>\`.\n`,
      );
      return EXIT.usage;
    }
    const name = nameOf(url);
    const prior = seen.get(name);
    if (prior) {
      process.stderr.write(
        `jux snap: '${prior}' and '${url}' would both be saved as '${name}'. Give them distinct paths, or snap them in separate commands with different --as-prefix values.\n`,
      );
      return EXIT.usage;
    }
    seen.set(name, url);
  }

  let captured: Awaited<ReturnType<typeof snapPages>>;
  try {
    captured = await snapPages({
      urls,
      ...(viewport ? { viewport } : {}),
      params: {
        ...(flags['wait-for'] ? { waitForSelector: flags['wait-for'] } : {}),
        ...(flags.mask?.length ? { mask: flags.mask } : {}),
      },
    });
  } catch (err) {
    // Only the browser itself can throw here; per-page problems come back as
    // results. No browser means nothing was captured, for any url.
    process.stderr.write(
      `jux snap: could not launch the browser: ${(err as Error).message}${captureHint((err as Error).message)}\n`,
    );
    return EXIT.failure;
  }
  const { env, pages } = captured;

  const dir = snapsDir(flags.project);
  const results: Array<Written | { url: string; error: string }> = [];
  let failed = 0;
  try {
    await mkdir(dir, { recursive: true });
    // Self-ignoring: snaps are scratch, never baselines.
    await writeFile(path.join(dir, '.gitignore'), '*\n');
    for (const r of pages) {
      const problem = describeFailure(r);
      if (problem) {
        failed++;
        process.stderr.write(`jux snap: ${problem}\n`);
        results.push({ url: r.url, error: problem });
        continue;
      }
      results.push(await write(dir, nameOf(r.url), r, env));
    }
  } catch (err) {
    process.stderr.write(
      `jux snap: could not write to ${dir}: ${(err as Error).message}. Check the directory is writable, or pass --project <dir>.\n`,
    );
    return EXIT.failure;
  }

  if (flags.json) {
    process.stdout.write(
      (urls.length === 1 && !prefix
        ? JSON.stringify(results[0])
        : JSON.stringify({ prefix: prefix ?? null, snaps: results })) + '\n',
    );
  } else {
    for (const r of results) {
      if ('error' in r) continue;
      process.stdout.write(
        `jux: snapped ${r.url} → ${r.name} (${r.elements} elements, ${r.durationMs} ms)\n`,
      );
    }
  }
  return failed > 0 ? EXIT.failure : EXIT.clean;
}

function describeFailure(r: SnapPageResult): string | null {
  if (r.error) return `could not capture ${r.url}: ${r.error}${captureHint(r.error)}`;
  if (r.status !== null && (r.status < 200 || r.status >= 300)) {
    return `${r.url} returned HTTP ${r.status}; nothing written. Fix the route or URL, then retry.`;
  }
  return null;
}

async function write(
  dir: string,
  name: string,
  r: SnapPageResult,
  env: CaptureEnv,
): Promise<Written> {
  const snapshot = r.snapshot!;
  const image = path.join(dir, `${name}.webp`);
  await writeFile(image, snapshot.image);
  const s = snapshot.structure;
  const sidecar = path.join(dir, `${name}.structure.json.gz`);
  // A previous snap's sidecar under this name would otherwise sit beside the
  // new pixels, and a later diff would pair them (Ruling 7, for snaps).
  await rm(sidecar, { force: true });
  if (s) await writeFile(sidecar, encodeStructure(s));
  return {
    url: r.url,
    name,
    image,
    structure: s ? sidecar : null,
    viewport: snapshot.viewport,
    env,
    structureHash: s?.structureHash ?? null,
    elements: s?.elements.length ?? 0,
    durationMs: snapshot.durationMs,
  };
}

/** The next step depends on what broke: a missing browser and a down server
 *  need different commands. Anything else shows its message alone. */
function captureHint(message: string): string {
  if (/Executable doesn't exist|Cannot find (package|module) 'playwright/i.test(message))
    return '. Install the browser with `npx playwright install chromium`, then retry.';
  if (
    /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(
      message,
    )
  )
    return '. Check the server is running and the URL is right, then retry.';
  return '';
}
