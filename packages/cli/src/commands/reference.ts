// Compare configured design PNGs with images already saved by `jux run`.
// This command never resolves a platform or opens a browser.
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  checkProjectSettle,
  compareDesignReference,
  encodeStoryId,
  parseRunReport,
  renderCrops,
  type DesignReferenceLedger,
  type DesignReferenceSpec,
} from '@juxtapose/core';
import { loadConfig } from '../context.js';
import { latestRunDir } from '../run-dir.js';
import { stdio, type Session } from '../io.js';

type State =
  | { name: string; storyId: string; status: 'error'; error: string }
  | (Omit<DesignReferenceLedger, 'regions'> & {
      regionCount: number;
      regions: DesignReferenceLedger['regions'];
    });

export interface ReferenceResult {
  schema: 'juxtapose.design-reference-set/v1';
  runId: string;
  policy: { method: 'pixelmatch'; threshold: 0.1; includeAA: false };
  summary: {
    pass: number;
    fail: number;
    incompatible: number;
    error: number;
    /** Configured targets without a capture in this run; excluded by default. */
    notCaptured: number;
  };
  states: State[];
  /** Present only when a region ID was requested. Left is target, right is current. */
  crop?: { regionId: string; png: Buffer };
}

const inside = (child: string, parent: string) =>
  child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

async function selectedRun(project: string, run: string | undefined): Promise<string> {
  const root = await realpath(path.join(project, '.juxtapose', 'runs'));
  if (!inside(root, project))
    throw new Error('jux: saved runs directory must remain inside the project');
  const candidate = run
    ? path.resolve(project, /^[a-zA-Z0-9_-]+$/.test(run) ? `.juxtapose/runs/${run}` : run)
    : await latestRunDir(project);
  if (!candidate) throw new Error('jux: no saved run found. Run `jux run` first.');
  const dir = await realpath(candidate);
  // A run must be a direct child. This rejects arbitrary --run paths and
  // symlinks escaping the project's run directory.
  if (path.dirname(dir) !== root)
    throw new Error('jux: --run must select a saved project run');
  return dir;
}

async function savedFile(runDir: string, file: string): Promise<Buffer> {
  const root = await realpath(runDir);
  const imageRoot = await realpath(path.join(root, 'images'));
  if (!inside(imageRoot, root)) throw new Error('run image directory escapes the run');
  const image = await realpath(path.join(imageRoot, file));
  if (!inside(image, imageRoot)) throw new Error('saved image escapes the run');
  return readFile(image);
}

/** Recompute from saved files, so region IDs survive an MCP restart. */
export async function evaluateReferences(options: {
  project: string;
  run?: string;
  name?: string;
  regionId?: string;
}): Promise<ReferenceResult> {
  const project = await realpath(options.project);
  const config = await loadConfig(project);
  checkProjectSettle(config); // validates the new designReferences map too
  const references = config.designReferences ?? {};
  const names = options.name ? [options.name] : Object.keys(references).sort();
  if (names.length === 0)
    throw new Error('jux: configure designReferences before comparing a design');
  if (options.name && !Object.hasOwn(references, options.name))
    throw new Error(`jux: unknown design reference '${options.name}'`);
  const runDir = await selectedRun(project, options.run);
  const reportFile = await realpath(path.join(runDir, 'report.json'));
  if (!inside(reportFile, runDir)) throw new Error('run report escapes the run');
  const report = parseRunReport(await readFile(reportFile, 'utf8'));
  const results = new Map(report.results.map((r) => [r.storyId, r]));
  const states: State[] = [];
  let notCaptured = 0;
  let crop: ReferenceResult['crop'];
  for (const name of names) {
    const reference = references[name] as DesignReferenceSpec;
    const result = results.get(reference.storyId);
    // `jux run` often captures only changed stories. A configured target for
    // another story is outside this comparison, not a broken capture. An
    // explicit name still reports the absent capture as an error.
    if ((!result || result.status === 'skip') && !options.name) {
      notCaptured++;
      continue;
    }
    if (!result || result.status === 'skip' || result.error || !result.viewport) {
      states.push({
        name,
        storyId: reference.storyId,
        status: 'error',
        error: !result
          ? 'capture key is absent from the saved run'
          : (result.error ?? 'saved run has no usable capture for this key'),
      });
      continue;
    }
    try {
      const current = await savedFile(
        runDir,
        `${encodeStoryId(reference.storyId)}-current.webp`,
      );
      const ledger = await compareDesignReference({
        projectRoot: project,
        name,
        reference,
        current: { storyId: result.storyId, image: current, viewport: result.viewport },
      });
      if (options.regionId) {
        const region = ledger.regions.find((r) => r.id === options.regionId);
        if (region) {
          const target = await readFile(ledger.referenceImage);
          const [rendered] = await renderCrops(target, current, [region]);
          if (!rendered) throw new Error('region lies outside the saved images');
          crop = { regionId: region.id, png: rendered.png };
        }
      }
      states.push({
        ...ledger,
        regionCount: ledger.regions.length,
        regions: ledger.regions.slice(0, 8),
      });
    } catch (err) {
      states.push({
        name,
        storyId: reference.storyId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (options.regionId && !crop)
    throw new Error(
      `jux: region '${options.regionId}' was not found in this saved comparison; the reference or capture may have changed. Run reference again for current region IDs.`,
    );
  return {
    schema: 'juxtapose.design-reference-set/v1',
    runId: report.runId,
    policy: { method: 'pixelmatch', threshold: 0.1, includeAA: false },
    summary: {
      pass: states.filter((s) => s.status === 'pass').length,
      fail: states.filter((s) => s.status === 'fail').length,
      incompatible: states.filter((s) => s.status === 'incompatible').length,
      error: states.filter((s) => s.status === 'error').length,
      notCaptured,
    },
    states,
    ...(crop ? { crop } : {}),
  };
}

export async function referenceCommand(
  name: string | undefined,
  flags: { project?: string; run?: string; json?: boolean; region?: string },
  { io = stdio }: Session = {},
): Promise<number> {
  if (flags.region && !flags.json) {
    io.err('jux: --region requires --json to return the PNG as base64\n');
    return 2;
  }
  try {
    const result = await evaluateReferences({
      project: path.resolve(flags.project ?? process.cwd()),
      ...(flags.run ? { run: flags.run } : {}),
      ...(name ? { name } : {}),
      ...(flags.region ? { regionId: flags.region } : {}),
    });
    if (flags.json) {
      io.out(
        JSON.stringify({
          ...result,
          ...(result.crop
            ? {
                crop: {
                  regionId: result.crop.regionId,
                  pngBase64: result.crop.png.toString('base64'),
                },
              }
            : {}),
        }) + '\n',
      );
    } else {
      const s = result.summary;
      io.out(
        `Design references · run ${result.runId}: ${s.pass} pass, ${s.fail} fail, ${s.incompatible} incompatible, ${s.error} error, ${s.notCaptured} not captured\n`,
      );
      io.out(
        'Policy: Pixelmatch threshold 0.1, antialiasing excluded; separate from approved-baseline policy.\n',
      );
      for (const state of result.states.slice(0, 20)) {
        if (state.status === 'error')
          io.out(`- ${state.name} (${state.storyId}): error — ${state.error}\n`);
        else if (state.status === 'incompatible')
          io.out(`- ${state.name} (${state.storyId}): incompatible — ${state.reason}\n`);
        else
          io.out(
            `- ${state.name} (${state.storyId}): ${state.status} — ${state.mismatchPixels} changed pixels (${state.mismatchPercent}%), ${state.regionCount} regions${state.regions.length ? `; first region ${state.regions[0]!.id}` : ''}\n`,
          );
      }
      if (result.states.length > 20)
        io.out(
          `… ${result.states.length - 20} more states; use --json for the full ledger.\n`,
        );
      io.out(
        'Use --json for measured geometry, bounded regions, stable region IDs and image paths.\n',
      );
    }
    return result.summary.error
      ? 3
      : result.summary.fail || result.summary.incompatible
        ? 1
        : 0;
  } catch (err) {
    io.err(`jux: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}
