// `jux snap <url>…` — deterministic captures, pixels plus structure, no
// workbench. The first half of the agent loop: snap before an edit, snap
// after, then `jux diff`. Several URLs share one browser launch so an agent
// can snap every page a shared component touches in one command.
//
// Exit 0 every page written, 2 usage, 3 the browser or any page failed. When
// one page of several fails the rest are still captured and written, the
// failed one is reported (with its error, in --json too) and the exit is 3:
// the agent asked for all of them, so a partial set must not look like success.

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  acquireBrowser,
  freezeImages,
  compareCodeUnits,
  encodeStructure,
  snapPages,
  type Browser,
  type CaptureEnv,
  type CaptureFlag,
  type SettleReport,
  type SnapPageResult,
  checkProjectSettle,
  configWarnings,
  captureFlags,
  VariantConfigError,
  type Viewport,
  shellQuote,
} from '@juxtapose/core';
import { EXIT } from '../exit-codes.js';
import { isRecord } from '../guards.js';
import { prefixSlugs, snapName } from '../snap-name.js';
import { snapsDir } from '../snaps-dir.js';
import { firstSymlink, symlinkRefusal, writeFresh } from '../symlink-guard.js';
import { stdio, type Session } from '../io.js';
import { loadConfig } from '../context.js';
import { settleFlagArgs, settleFromFlags, type SettleFlags } from '../settle-flags.js';

export interface SnapFlags extends SettleFlags {
  delay?: string;
  json?: boolean;
  project?: string;
  as?: string;
  'as-prefix'?: string;
  viewport?: string;
  'full-page'?: boolean;
  'wait-for'?: string;
  mask?: string[];
  chrome?: string;
  'no-daemon'?: boolean;
  'no-fresh-renderer'?: boolean;
}

export const MAX_VIEWPORT_SIDE = 10000;

interface Written {
  url: string;
  name: string;
  image: string;
  structure: string | null;
  viewport: Viewport;
  layoutViewport?: Viewport;
  env: CaptureEnv;
  structureHash: string | null;
  elements: number;
  durationMs: number;
  /** Present only when the capture raised a flag (settle, renderer-reused). */
  flags?: CaptureFlag[];
  /** Present only when the settle wait hit its cap. */
  settle?: SettleReport;
}

export async function snapCommand(
  urls: string[],
  flags: SnapFlags,
  { io = stdio, browser: lent }: Session = {},
): Promise<number> {
  if (urls.length === 0) {
    io.err(
      'jux snap: missing <url>. Try `jux snap http://localhost:5173 --as before`.\n',
    );
    return EXIT.usage;
  }
  if (urls.length > 1 && flags.as) {
    io.err(
      'jux snap: --as names one snap; for several urls use --as-prefix <p> (snaps are named <p>-<slug>).\n',
    );
    return EXIT.usage;
  }
  if (flags.as && flags['as-prefix']) {
    io.err('jux snap: use --as or --as-prefix, not both.\n');
    return EXIT.usage;
  }
  let viewport: Viewport | undefined;
  if (flags.viewport) {
    const m = /^(\d+)x(\d+)$/.exec(flags.viewport);
    // 0 passes the pattern but Playwright rejects it, which surfaced as exit 1
    // "could not capture" for what is a usage error.
    // The upper bound: lossless WebP cannot encode a side above 16383 px, and
    // a 10000x10000 frame is already a 400 MB RGBA buffer. Past it the capture
    // fails late with an encoder or out-of-memory error instead of a usage one.
    if (
      !m ||
      Number(m[1]) === 0 ||
      Number(m[2]) === 0 ||
      Number(m[1]) > MAX_VIEWPORT_SIDE ||
      Number(m[2]) > MAX_VIEWPORT_SIDE
    ) {
      io.err(
        `jux snap: --viewport must be WxH, each 1 to ${MAX_VIEWPORT_SIDE}, got '${flags.viewport}'. Try --viewport 1280x800.\n`,
      );
      return EXIT.usage;
    }
    viewport = { width: Number(m[1]), height: Number(m[2]) };
  }

  const call = settleFromFlags(flags, 'jux snap');
  if ('error' in call) {
    io.err(`${call.error}\n`);
    return EXIT.usage;
  }
  let delay: number | undefined;
  if (flags.delay !== undefined) {
    delay = /^\d+$/.test(flags.delay) ? Number(flags.delay) : NaN;
    if (!Number.isSafeInteger(delay)) {
      io.err(
        `jux snap: --delay must be a whole number of ms, got '${flags.delay}'. Prefer --wait-for <selector>; a delay costs the same on every snap.\n`,
      );
      return EXIT.usage;
    }
  }
  // The project config's settle options sit under the flags. A bad one is
  // a usage error, as it is for `jux run`.
  const config = await loadConfig(path.resolve(flags.project ?? process.cwd()));
  try {
    checkProjectSettle(config);
  } catch (err) {
    if (!(err instanceof VariantConfigError)) throw err;
    io.err(`${err.message}\n`);
    return EXIT.usage;
  }
  for (const m of configWarnings(config)) io.err(`jux: ${m}\n`);

  const prefix = flags['as-prefix']
    ? snapName(flags['as-prefix'], flags['as-prefix'])
    : undefined;
  // Prefix names are path-based so before/after pair across a dev-server port
  // change; see prefixSlugs. Single-url naming is unchanged.
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      io.err(
        `jux snap: '${url}' is not an http(s) URL. Serve the page (e.g. \`vite\`) and run \`jux snap http://localhost:<port>/ --as <name>\`.\n`,
      );
      return EXIT.usage;
    }
  }
  let slugOf = new Map<string, string>();
  try {
    if (prefix) slugOf = prefixSlugs(urls);
  } catch (err) {
    io.err(`jux snap: not a valid URL: ${String(err)}. Check the arguments.\n`);
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
      io.err(
        `jux snap: '${prior}' and '${url}' would both be saved as '${name}'. They differ only by a trailing slash or punctuation, which names do not keep. Snap them one at a time with \`jux snap <url> --as <name>\`.\n`,
      );
      return EXIT.usage;
    }
    seen.set(name, url);
  }

  // Before the browser, and before any rm or write under the snaps dir.
  const link = await firstSymlink(path.resolve(flags.project ?? process.cwd()), [
    '.juxtapose',
    'snaps',
    '.gitignore',
  ]);
  if (link) {
    io.err(symlinkRefusal(link));
    return EXIT.failure;
  }

  let captured: Awaited<ReturnType<typeof snapPages>>;
  let browser: Browser | undefined;
  try {
    browser = lent
      ? await lent()
      : await acquireBrowser({
          chrome: flags.chrome,
          noDaemon: flags['no-daemon'] === true,
          freezeImages: freezeImages(config),
        });
    captured = await snapPages({
      urls,
      browser,
      renderer:
        flags['no-fresh-renderer'] === true
          ? { ...config.renderer, shared: true }
          : config.renderer,
      ...(config.storyTimeout !== undefined
        ? { storyTimeoutMs: config.storyTimeout }
        : {}),
      ...(flags['no-fresh-renderer'] === true
        ? { freshRenderer: false }
        : config.freshRenderer !== undefined
          ? { freshRenderer: config.freshRenderer }
          : {}),
      ...(viewport ? { viewport } : {}),
      // A snap has no story: the flags are the story layer, over the config.
      params: {
        ...(flags['full-page'] ? { fullPage: true } : {}),
        ...(flags['wait-for'] ? { waitForSelector: flags['wait-for'] } : {}),
        ...(flags.mask?.length ? { mask: flags.mask } : {}),
        ...(delay !== undefined ? { delay } : {}),
        ...(call.settle ? { settle: call.settle } : {}),
        ...(call.network ? { network: call.network } : {}),
      },
      projectSettle: {
        ...(config.settle ? { settle: config.settle } : {}),
        ...(config.network ? { network: config.network } : {}),
        ...(config.freeze ? { freeze: config.freeze } : {}),
        ...(config.waitForSelector !== undefined
          ? { waitForSelector: config.waitForSelector }
          : {}),
        ...(config.delay !== undefined ? { delay: config.delay } : {}),
      },
    });
  } catch (err) {
    // Only the browser itself can throw here; per-page problems come back as
    // results. No browser means nothing was captured, for any url.
    io.err(`${describeLaunchFailure(errorMessage(err))}\n`);
    return EXIT.failure;
  } finally {
    // A lent browser belongs to the session (`jux mcp`) and outlives this call.
    if (!lent) await browser?.close().catch(() => {});
  }
  const { env, pages } = captured;

  const dir = snapsDir(flags.project);
  const results: Array<Written | { url: string; error: string }> = [];
  const failedUrls: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
    // Self-ignoring: snaps are scratch, never baselines.
    await writeFresh(path.join(dir, '.gitignore'), '*\n');
    // A smaller page set must not leave last run's snaps to pair with; the
    // dir is scratch, so this is safe. Done after capture so a failed launch
    // deletes nothing.
    if (prefix) {
      await clearPrefix(dir, prefix);
      await writeSnapSet(dir, prefix, urls.map(nameOf));
    }
  } catch (err) {
    io.err(
      `jux snap: could not write to ${dir}: ${errorMessage(err)}. Check the directory is writable, or pass --project <dir>.\n`,
    );
    return EXIT.failure;
  }
  for (const r of pages) {
    let problem = describeFailure(r);
    if (!problem) {
      try {
        results.push(await writeSnap(dir, nameOf(r.url), r, env));
        continue;
      } catch (err) {
        problem = `could not write ${nameOf(r.url)} to ${dir}: ${errorMessage(err)}. Check the directory is writable, or pass --project <dir>.`;
      }
    }
    failedUrls.push(r.url);
    io.err(`jux snap: ${problem}\n`);
    results.push({ url: r.url, error: problem });
  }
  const failed = failedUrls.length;

  if (flags.json) {
    io.out(
      (urls.length === 1 && !prefix
        ? JSON.stringify(results[0])
        : JSON.stringify({ prefix: prefix ?? null, snaps: results })) + '\n',
    );
  } else {
    for (const r of results) {
      if ('error' in r) continue;
      io.out(
        `jux: snapped ${r.url} → ${r.name} (${r.elements} elements, ${r.durationMs} ms)\n`,
      );
      if (r.settle) {
        io.out(
          r.settle.status === 'timeout'
            ? `  settle-timeout: captured at the ${r.settle.timeoutMs} ms cap; pending: ${r.settle.pending.join('; ')}\n`
            : `  settle-fallback: ${r.settle.pending.join('; ')}\n`,
        );
      }
      if (r.flags?.includes('renderer-reused')) {
        io.out(
          `  renderer-reused: captured in a renderer process an earlier page used, so its pixels can depend on that page (#153)\n`,
        );
      }
    }
    if (urls.length > 1 || failed) {
      io.out(
        `${urls.length - failed} of ${urls.length} pages written; ${failed} failed\n`,
      );
    }
    for (const url of failedUrls) {
      io.out(`retry: ${retryCommand(url, nameOf(url), flags)}\n`);
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
  if (flags['full-page']) parts.push('--full-page');
  if (flags['wait-for']) parts.push('--wait-for', shellQuote(flags['wait-for']));
  for (const m of flags.mask ?? []) parts.push('--mask', shellQuote(m));
  if (flags.delay !== undefined) parts.push('--delay', shellQuote(flags.delay));
  parts.push(...settleFlagArgs(flags));
  if (flags.project) parts.push('--project', shellQuote(flags.project));
  return parts.join(' ');
}

/** Remove the snaps (image and sidecar) a previous `--as-prefix <prefix>`
 *  run wrote. `<prefix>.set.json` lists them; matching `<prefix>-*` instead
 *  would also delete a longer prefix's snaps (`a` clears `a-b-home`). With no
 *  set file — snaps from before it existed — that glob is the fallback. A
 *  listed name outside `<prefix>-` is ignored, so an edited set file cannot
 *  reach another prefix's snaps. */
export async function clearPrefix(dir: string, prefix: string): Promise<void> {
  const listed = await readSnapSet(dir, prefix);
  for (const f of await readdir(dir)) {
    const name = /^(.*)\.(webp|structure\.json\.gz)$/.exec(f)?.[1];
    if (name === undefined || !name.startsWith(`${prefix}-`)) continue;
    if (listed && !listed.has(name)) continue;
    await rm(path.join(dir, f), { force: true });
  }
}

const setFile = (dir: string, prefix: string) => path.join(dir, `${prefix}.set.json`);

/** Record the snap names a prefixed run is about to write (every requested
 *  page, written or not: a failed page's old snap was cleared too). */
export async function writeSnapSet(
  dir: string,
  prefix: string,
  names: string[],
): Promise<void> {
  const sorted = [...new Set(names)].sort(compareCodeUnits);
  await writeFresh(setFile(dir, prefix), JSON.stringify({ names: sorted }) + '\n');
}

async function readSnapSet(dir: string, prefix: string): Promise<Set<string> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(setFile(dir, prefix), 'utf8'));
    const names = isRecord(parsed) ? parsed['names'] : undefined;
    if (!Array.isArray(names) || !names.every((n): n is string => typeof n === 'string'))
      return null;
    return new Set(names);
  } catch {
    return null; // absent or unreadable: fall back to the prefix glob
  }
}

/** Core messages carry their own `jux: ` and, for launch failures, their own
 *  "could not launch the browser: "; wrapped, both read doubled. */
const stripJuxPrefix = (m: string): string =>
  m.replace(/^jux: /, '').replace(/^could not launch the browser: /, '');

/** The message plus its hint. The hint opens with ". ", so a message that
 *  already ends in a period would print "ready.. Run". */
function withHint(message: string): string {
  const hint = captureHint(message);
  const body = stripJuxPrefix(message);
  return hint ? `${body.replace(/\.$/, '')}${hint}` : body;
}

export function describeLaunchFailure(message: string): string {
  return `jux snap: could not launch the browser: ${withHint(message)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeFailure(r: SnapPageResult): string | null {
  if (r.error) return `could not capture ${r.url}: ${withHint(r.error)}`;
  if (r.status !== null && (r.status < 200 || r.status >= 300)) {
    return `${r.url} returned HTTP ${r.status}; nothing written. Fix the route or URL, then retry.`;
  }
  return null;
}

export async function writeSnap(
  dir: string,
  name: string,
  r: SnapPageResult,
  env: CaptureEnv,
): Promise<Written> {
  const snapshot = r.snapshot!;
  const image = path.join(dir, `${name}.webp`);
  await writeFresh(image, snapshot.image);
  const s = snapshot.structure;
  const sidecar = path.join(dir, `${name}.structure.json.gz`);
  // A previous snap's sidecar under this name would otherwise sit beside the
  // new pixels, and a later diff would pair them (Ruling 7, for snaps).
  await rm(sidecar, { force: true });
  if (s) await writeFresh(sidecar, encodeStructure(s));
  return {
    url: r.url,
    name,
    image,
    structure: s ? sidecar : null,
    viewport: snapshot.viewport,
    ...(snapshot.layoutViewport ? { layoutViewport: snapshot.layoutViewport } : {}),
    env,
    structureHash: s?.structureHash ?? null,
    elements: s?.elements.length ?? 0,
    durationMs: snapshot.durationMs,
    ...(captureFlags(snapshot).length > 0 ? { flags: captureFlags(snapshot) } : {}),
    ...(snapshot.settle ? { settle: snapshot.settle } : {}),
  };
}

/** The next step depends on what broke: a missing browser and a down server
 *  need different commands. Anything else shows its message alone. */
export function captureHint(message: string): string {
  // The core messages (noBrowserMessage, launch failures) already name the
  // install step; repeating it would print it twice.
  if (/jux browser install/.test(message)) return '';
  if (/could not launch the browser|does not exist/.test(message))
    return '. Run `npx -p @juxtapose/cli jux browser install`, or set JUX_CHROME=<path>, then retry.';
  if (
    /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(
      message,
    )
  )
    return '. Check the server is running and the URL is right, then retry.';
  return '';
}
