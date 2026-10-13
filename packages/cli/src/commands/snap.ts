// `jux snap <url>…` — deterministic captures, pixels plus structure, no
// workbench. The first half of the agent loop: snap before an edit, snap
// after, then `jux diff`. Several URLs share one browser launch so an agent
// can snap every page a shared component touches in one command.
//
// Exit 0 every page written, 2 usage, 3 the browser or any page failed. When
// one page of several fails the rest are still captured and written, the
// failed one is reported (with its error, in --json too) and the exit is 3:
// the agent asked for all of them, so a partial set must not look like success.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  encodeStructure,
  snapPages,
  type CaptureEnv,
  type SnapPageResult,
  type Viewport,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
import { shellQuote } from '../shell-quote.js';
import { prefixSlugs, snapName } from '../snap-name.js';
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
  // Prefix names are path-based so before/after pair across a dev-server port
  // change; see prefixSlugs. Single-url naming is unchanged.
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      process.stderr.write(
        `jux snap: '${url}' is not an http(s) URL. Serve the page (e.g. \`vite\`) and run \`jux snap http://localhost:<port>/ --as <name>\`.\n`,
      );
      return EXIT.usage;
    }
  }
  let slugOf = new Map<string, string>();
  try {
    if (prefix) slugOf = prefixSlugs(urls);
  } catch (err) {
    process.stderr.write(
      `jux snap: not a valid URL: ${String(err)}. Check the arguments.\n`,
    );
    return EXIT.usage;
  }
  const nameOf = (url: string) =>
    prefix ? `${prefix}-${slugOf.get(url) ?? snapName(url)}` : snapName(url, flags.as);

  // Validate every url before launching anything: a bad argument is a usage
  // error, and names derive from host + path, so two urls differing only by
  // query would silently overwrite each other.
  const seen = new Map<string, string>();
  for (const url of urls) {
    const name = nameOf(url);
    const prior = seen.get(name);
    if (prior) {
      process.stderr.write(
        `jux snap: '${prior}' and '${url}' would both be saved as '${name}'. They differ only by a trailing slash or punctuation, which names do not keep. Snap them one at a time with \`jux snap <url> --as <name>\`.\n`,
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
      `jux snap: could not launch the browser: ${errorMessage(err)}${captureHint(errorMessage(err))}\n`,
    );
    return EXIT.failure;
  }
  const { env, pages } = captured;

  const dir = snapsDir(flags.project);
  const results: Array<Written | { url: string; error: string }> = [];
  const failedUrls: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
    // Self-ignoring: snaps are scratch, never baselines.
    await writeFile(path.join(dir, '.gitignore'), '*\n');
    // A smaller page set must not leave last run's snaps to pair with; the
    // dir is scratch, so this is safe. Done after capture so a failed launch
    // deletes nothing.
    if (prefix) await clearPrefix(dir, prefix);
  } catch (err) {
    process.stderr.write(
      `jux snap: could not write to ${dir}: ${errorMessage(err)}. Check the directory is writable, or pass --project <dir>.\n`,
    );
    return EXIT.failure;
  }
  for (const r of pages) {
    let problem = describeFailure(r);
    if (!problem) {
      try {
        results.push(await write(dir, nameOf(r.url), r, env));
        continue;
      } catch (err) {
        problem = `could not write ${nameOf(r.url)} to ${dir}: ${errorMessage(err)}. Check the directory is writable, or pass --project <dir>.`;
      }
    }
    failedUrls.push(r.url);
    process.stderr.write(`jux snap: ${problem}\n`);
    results.push({ url: r.url, error: problem });
  }
  const failed = failedUrls.length;

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
    if (urls.length > 1 || failed) {
      process.stdout.write(
        `${urls.length - failed} of ${urls.length} pages written; ${failed} failed\n`,
      );
    }
    for (const url of failedUrls) {
      process.stdout.write(`retry: ${retryCommand(url, nameOf(url), flags)}\n`);
    }
  }
  return failed > 0 ? EXIT.failure : EXIT.clean;
}

/**
 * The command that re-takes one failed page exactly as it was asked for:
 * every capture flag is repeated. It uses `--as <full name>`, not
 * `--as-prefix`, because a prefixed run clears the prefix's other snaps and
 * the retry must only touch this page.
 */
function retryCommand(url: string, name: string, flags: SnapFlags): string {
  const parts = ['jux', 'snap', shellQuote(url), '--as', shellQuote(name)];
  if (flags.viewport) parts.push('--viewport', shellQuote(flags.viewport));
  if (flags['wait-for']) parts.push('--wait-for', shellQuote(flags['wait-for']));
  for (const m of flags.mask ?? []) parts.push('--mask', shellQuote(m));
  if (flags.project) parts.push('--project', shellQuote(flags.project));
  return parts.join(' ');
}

/** Remove `<prefix>-* snaps (image and sidecar) from a previous run. */
async function clearPrefix(dir: string, prefix: string): Promise<void> {
  for (const f of await readdir(dir)) {
    if (f.startsWith(`${prefix}-`) && /\.(webp|structure\.json\.gz)$/.test(f))
      await rm(path.join(dir, f), { force: true });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
