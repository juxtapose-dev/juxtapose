// Compare configured design PNGs with images already saved by `jux run`.
// This command never resolves a platform or opens a browser.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  checkProjectSettle,
  compareDesignReference,
  decodeStructure,
  diffImages,
  encodeStoryId,
  observeReferenceOutlines,
  parseRunReport,
  renderCrops,
  structuralDiff,
  type Crop,
  type Delta,
  type DesignReferenceLedger,
  type DiffResult,
  type DesignReferenceSpec,
  type ReferenceOutlineObservation,
} from '@juxtapose/core';
import { loadConfig } from '../context.js';
import { latestRunDir } from '../run-dir.js';
import { stdio, type Session } from '../io.js';
import { observedChanges } from './agent-run-report.js';
import { ReferenceLayoutCache, type ReferenceLayoutDetail } from './reference-layout.js';

export interface TargetProgress {
  fromRun: string;
  pixels: [number, number];
  trend: 'closer' | 'further' | 'same';
}

type State =
  | { name: string; storyId: string; status: 'error'; error: string }
  | (Omit<DesignReferenceLedger, 'regions'> & {
      regionCount: number;
      regions: DesignReferenceLedger['regions'];
      outline?: ReferenceOutlineObservation;
      progress?: TargetProgress;
      bestRun?: string;
      layout?: ReferenceLayoutDetail | { status: 'unavailable'; reason: string };
    });

export type ReferenceCrop = Pick<Crop, 'box' | 'scale' | 'width' | 'height' | 'png'> & {
  regionId: string;
};

function referenceCrop(regionId: string, rendered: Crop): ReferenceCrop {
  const { box, scale, width, height, png } = rendered;
  return { regionId, box, scale, width, height, png };
}

export interface ReferenceResult {
  schema: 'juxtapose.design-reference-set/v1';
  runId: string;
  outcome: 'pass' | 'fail' | 'error' | 'no-comparison';
  message?: string;
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
  crop?: ReferenceCrop;
}

export interface ReferenceChangeResult {
  schema: 'juxtapose.saved-run-change/v1';
  fromRunId: string;
  toRunId: string;
  policy: { method: 'pixelmatch'; threshold: 0.1; includeAA: false };
  states: Array<{
    name: string;
    storyId: string;
    status: 'changed' | 'unchanged' | 'incompatible' | 'not-comparable';
    reason?: string;
    previousHash?: string;
    currentHash?: string;
    changedPixels?: number;
    changedPercent?: number;
    regions?: Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      changedPixels?: number;
    }>;
    /** The saved structure sidecars of both runs, compared as `jux diff`
     *  compares two snaps. Absent when either sidecar is missing. */
    structural?: { classification: string; deltaCount: number; deltas: Delta[] };
  }>;
  /** Observed earlier→later facts deduplicated across the changed states. */
  changes?: string[];
  crop?: ReferenceCrop;
}

const inside = (child: string, parent: string) =>
  child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function colorText(rgba: [number, number, number, number]): string {
  const rgb = rgba
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return rgba[3] === 255 ? `#${rgb}` : `#${rgb}${rgba[3].toString(16).padStart(2, '0')}`;
}

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

/** Turn a cached region into an image without running Pixelmatch again. The
 * saved image hashes are checked before using its old coordinates. */
export async function cropReferenceChange(options: {
  project: string;
  fromRun: string;
  toRun: string;
  result: ReferenceChangeResult;
  regionId: string;
  name?: string;
}): Promise<ReferenceChangeResult['crop']> {
  const state = options.result.states.find(
    (candidate) =>
      (!options.name || candidate.name === options.name) &&
      candidate.regions?.some((region) => region.id === options.regionId),
  );
  const region = state?.regions?.find((item) => item.id === options.regionId);
  if (!state || !region || !state.previousHash || !state.currentHash)
    throw new Error(
      `jux: region '${options.regionId}' was not found in this saved comparison`,
    );
  const project = await realpath(options.project);
  const [fromDir, toDir] = await Promise.all([
    selectedRun(project, options.fromRun),
    selectedRun(project, options.toRun),
  ]);
  const file = `${encodeStoryId(state.storyId)}-current.webp`;
  const [left, right] = await Promise.all([
    savedFile(fromDir, file),
    savedFile(toDir, file),
  ]);
  const hash = (image: Buffer) => createHash('sha256').update(image).digest('hex');
  if (hash(left) !== state.previousHash || hash(right) !== state.currentHash)
    throw new Error('jux: saved capture changed; request a fresh region ID');
  const [rendered] = await renderCrops(left, right, [region]);
  if (!rendered) throw new Error('jux: region lies outside the saved images');
  return referenceCrop(region.id, rendered);
}

/** Compare two immutable saved runs, such as a checkpoint and a later attempt:
 * the edit's image and structure delta, not a change in distance to the
 * design target. No browser or recapture. */
export async function evaluateReferenceChange(options: {
  project: string;
  fromRun: string;
  /** Defaults to the latest run. */
  toRun?: string;
  /** A design reference name, or a capture key present in either run. */
  name?: string;
  regionId?: string;
}): Promise<ReferenceChangeResult> {
  const project = await realpath(options.project);
  const config = await loadConfig(project);
  checkProjectSettle(config);
  const references = config.designReferences ?? {};
  const [fromDir, toDir] = await Promise.all([
    selectedRun(project, options.fromRun),
    selectedRun(project, options.toRun),
  ]);
  if (fromDir === toDir) throw new Error('jux: fromRun and toRun must be different runs');
  const readReport = async (dir: string) => {
    const file = await realpath(path.join(dir, 'report.json'));
    if (!inside(file, dir)) throw new Error('run report escapes the run');
    return parseRunReport(await readFile(file, 'utf8'));
  };
  const [before, after] = await Promise.all([readReport(fromDir), readReport(toDir)]);
  const previous = new Map(before.results.map((r) => [r.storyId, r]));
  const current = new Map(after.results.map((r) => [r.storyId, r]));
  // Design references keep their names; every other capture both runs saved
  // follows under its own key, so a checkpoint covers projects without
  // design PNGs and stories no reference names.
  let targets: Array<{ name: string; storyId: string }>;
  if (options.name !== undefined) {
    if (Object.hasOwn(references, options.name))
      targets = [
        {
          name: options.name,
          storyId: (references[options.name] as DesignReferenceSpec).storyId,
        },
      ];
    else if (previous.has(options.name) || current.has(options.name))
      targets = [{ name: options.name, storyId: options.name }];
    else
      throw new Error(
        `jux: '${options.name}' is neither a design reference nor a capture in either run`,
      );
  } else {
    const named = Object.keys(references)
      .sort()
      .map((name) => ({
        name,
        storyId: (references[name] as DesignReferenceSpec).storyId,
      }));
    const covered = new Set(named.map((target) => target.storyId));
    const shared = [...current.keys()]
      .filter((id) => previous.has(id) && !covered.has(id))
      .sort();
    targets = [...named, ...shared.map((storyId) => ({ name: storyId, storyId }))];
  }
  if (!targets.length) throw new Error('jux: the two runs share no captures');
  const states: ReferenceChangeResult['states'] = [];
  let crop: ReferenceChangeResult['crop'];
  for (const { name, storyId } of targets) {
    const a = previous.get(storyId);
    const b = current.get(storyId);
    if (
      !a ||
      !b ||
      a.status === 'skip' ||
      b.status === 'skip' ||
      a.error ||
      b.error ||
      !a.viewport ||
      !b.viewport
    ) {
      states.push({
        name,
        storyId,
        status: 'not-comparable',
        reason: 'usable capture missing from one run',
      });
      continue;
    }
    if (
      a.viewport.width !== b.viewport.width ||
      a.viewport.height !== b.viewport.height
    ) {
      states.push({ name, storyId, status: 'incompatible', reason: 'viewport changed' });
      continue;
    }
    try {
      const file = `${encodeStoryId(storyId)}-current.webp`;
      const [left, right] = await Promise.all([
        savedFile(fromDir, file),
        savedFile(toDir, file),
      ]);
      const previousHash = createHash('sha256').update(left).digest('hex');
      const currentHash = createHash('sha256').update(right).digest('hex');
      const comparisonId = createHash('sha256')
        .update(`${storyId}\0${previousHash}\0${currentHash}\0pixelmatch:0.1`)
        .digest('hex');
      const diff =
        previousHash === currentHash
          ? {
              mismatchPixels: 0,
              mismatchPercent: 0,
              dimensionMismatch: false,
              changedRegions: [],
            }
          : await diffImages(left, right, { threshold: 0.1, includeRegionCounts: true });
      if (diff.dimensionMismatch) {
        states.push({
          name,
          storyId,
          status: 'incompatible',
          reason: 'image dimensions changed',
        });
        continue;
      }
      const regions = (diff.rankedChangedRegions ?? diff.changedRegions)
        .slice(0, 8)
        .map((r, i) => ({ ...r, id: `${comparisonId.slice(0, 16)}:${i + 1}` }));
      if (options.regionId) {
        const region = regions.find((r) => r.id === options.regionId);
        if (region) {
          const [rendered] = await renderCrops(left, right, [region]);
          if (rendered) crop = referenceCrop(region.id, rendered);
        }
      }
      const structural =
        previousHash === currentHash
          ? undefined
          : await savedStructural(fromDir, toDir, storyId, diff);
      states.push({
        name,
        storyId,
        status: diff.mismatchPixels ? 'changed' : 'unchanged',
        previousHash,
        currentHash,
        changedPixels: diff.mismatchPixels,
        changedPercent: diff.mismatchPercent,
        regions,
        ...(structural ? { structural } : {}),
      });
    } catch (err) {
      states.push({
        name,
        storyId,
        status: 'not-comparable',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (options.regionId && !crop)
    throw new Error(
      `jux: region '${options.regionId}' was not found in this saved comparison`,
    );
  const changes = observedChanges(
    states
      .filter((state) => state.structural?.deltas.length)
      .map(
        (state) =>
          ({
            storyId: state.storyId,
            status: 'fail',
            structural: state.structural,
          }) as DiffResult,
      ),
  );
  return {
    schema: 'juxtapose.saved-run-change/v1',
    fromRunId: before.runId,
    toRunId: after.runId,
    policy: { method: 'pixelmatch', threshold: 0.1, includeAA: false },
    states,
    ...(changes.length ? { changes } : {}),
    ...(crop ? { crop } : {}),
  };
}

/** The structural verdict between two saved runs' sidecars for one capture,
 *  or undefined when either run saved none (a capture error, an old run). */
async function savedStructural(
  fromDir: string,
  toDir: string,
  storyId: string,
  pixels: { changedRegions: DiffResult['changedRegions']; dimensionMismatch: boolean },
): Promise<ReferenceChangeResult['states'][number]['structural']> {
  const file = `${encodeStoryId(storyId)}-current.structure.json.gz`;
  const read = (dir: string) =>
    savedFile(dir, file).then(
      (gz) => decodeStructure(gz),
      () => undefined,
    );
  const [baseline, current] = await Promise.all([read(fromDir), read(toDir)]);
  if (!baseline || !current) return undefined;
  const verdict = structuralDiff({
    baseline,
    current,
    imagesIdentical: false,
    pixels,
    escalate: { command: 'reference compare=previous region=<id>' },
  });
  return {
    classification: verdict.classification,
    deltaCount: verdict.deltaCount,
    deltas: verdict.deltas,
  };
}

/** Recompute from saved files, so region IDs survive an MCP restart. */
export async function evaluateReferences(options: {
  project: string;
  run?: string;
  name?: string;
  regionId?: string;
  /** Requested diagnostics: up to two high-mismatch states, without recapture. */
  includeOutlines?: boolean;
  /** Requested JSON detail only; never computes evidence for a passing target. */
  includeLayout?: boolean;
  layoutCache?: ReferenceLayoutCache;
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
  const evaluated = new Array<State | undefined>(names.length);
  const crops = new Array<ReferenceResult['crop']>(names.length);
  const layoutCache = options.layoutCache ?? new ReferenceLayoutCache();
  let notCaptured = 0;
  let cursor = 0;
  // Four saved states took 100ms with derived caches cold versus 69ms with
  // concurrent reads/decode. Bound memory to four targets; CPU work remains
  // on this thread. Indexed results preserve sorted names despite I/O order.
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= names.length) return;
      const name = names[index]!;
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
        evaluated[index] = {
          name,
          storyId: reference.storyId,
          status: 'error',
          error: !result
            ? 'capture key is absent from the saved run'
            : (result.error ?? 'saved run has no usable capture for this key'),
        };
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
          current: {
            storyId: result.storyId, image: current, viewport: result.viewport,
            ...(result.layoutViewport ? { layoutViewport: result.layoutViewport, captureKind: 'full-page' as const } : {}),
          },
          cacheDir: path.join(runDir, 'reference-analysis-v1'),
        });
        let layout: Extract<State, { geometry: unknown }>['layout'];
        if (options.includeLayout && ledger.status === 'fail') {
          try {
            const [target, structure] = await Promise.all([
              readFile(ledger.referenceImage),
              savedFile(
                runDir,
                `${encodeStoryId(reference.storyId)}-current.structure.json.gz`,
              ),
            ]);
            layout = await layoutCache.evaluate({
              project,
              reference: target,
              current,
              structure,
              referenceHash: ledger.referenceHash,
              currentHash: ledger.currentHash,
            });
          } catch (error) {
            layout = {
              status: 'unavailable',
              reason: (error instanceof Error ? error.message : String(error)).slice(
                0,
                240,
              ),
            };
          }
        }
        if (options.regionId) {
          const region = ledger.regions.find((r) => r.id === options.regionId);
          if (region) {
            const target = await readFile(ledger.referenceImage);
            const [rendered] = await renderCrops(target, current, [region]);
            if (!rendered) throw new Error('region lies outside the saved images');
            crops[index] = referenceCrop(region.id, rendered);
          }
        }
        evaluated[index] = {
          ...ledger,
          regionCount: ledger.regions.length,
          regions: ledger.regions.slice(0, 8),
          ...(layout ? { layout } : {}),
        };
      } catch (err) {
        evaluated[index] = {
          name,
          storyId: reference.storyId,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
  const states = evaluated.filter((state): state is State => state !== undefined);
  // Collect crops in name order, matching the serial evaluator's selection
  // rather than whichever asynchronous request ends last.
  let crop: ReferenceResult['crop'];
  for (const candidate of crops) if (candidate) crop = candidate;
  if (options.regionId && !crop)
    throw new Error(
      `jux: region '${options.regionId}' was not found in this saved comparison; the reference or capture may have changed. Run reference again for current region IDs.`,
    );
  if (options.includeOutlines) {
    const failing = states
      .filter(
        (state): state is Extract<State, { regions: unknown }> =>
          state.status === 'fail' &&
          'regions' in state &&
          state.regions.length > 0 &&
          state.geometry.deviceScaleFactor === 1,
      )
      .sort((a, b) => (b.mismatchPixels ?? 0) - (a.mismatchPixels ?? 0));
    // First cover distinct viewports, then spend any remaining slot on the
    // next-largest failure. Desktop and mobile often have different causes.
    const candidates: typeof failing = [];
    const viewports = new Set<string>();
    for (const state of failing) {
      const key = JSON.stringify(state.geometry.viewport);
      if (viewports.has(key)) continue;
      candidates.push(state);
      viewports.add(key);
      if (candidates.length === 2) break;
    }
    for (const state of failing) {
      if (candidates.length === 2) break;
      if (!candidates.includes(state)) candidates.push(state);
    }
    for (const state of candidates) {
      if (state.status !== 'fail') continue;
      try {
        const key = encodeStoryId(state.storyId);
        const [current, structureBytes, target] = await Promise.all([
          savedFile(runDir, `${key}-current.webp`),
          savedFile(runDir, `${key}-current.structure.json.gz`),
          readFile(state.referenceImage),
        ]);
        const sha256 = (bytes: Buffer) =>
          createHash('sha256').update(bytes).digest('hex');
        if (
          sha256(current) !== state.currentHash ||
          sha256(target) !== state.referenceHash
        )
          continue;
        const structure = decodeStructure(structureBytes);
        if (
          structure.viewport.width !== state.geometry.viewport.width ||
          structure.viewport.height !== state.geometry.viewport.height
        )
          continue;
        const outline = await observeReferenceOutlines({
          reference: target,
          current,
          structure,
          region: state.regions[0]!,
        });
        if (outline) state.outline = outline;
      } catch {
        // An optional image clue must never alter the comparison verdict.
      }
    }
  }
  const summary = {
    pass: states.filter((s) => s.status === 'pass').length,
    fail: states.filter((s) => s.status === 'fail').length,
    incompatible: states.filter((s) => s.status === 'incompatible').length,
    error: states.filter((s) => s.status === 'error').length,
    notCaptured,
  };
  const outcome =
    states.length === 0
      ? 'no-comparison'
      : summary.error
        ? 'error'
        : summary.fail || summary.incompatible
          ? 'fail'
          : 'pass';
  return {
    schema: 'juxtapose.design-reference-set/v1',
    runId: report.runId,
    outcome,
    ...(outcome === 'no-comparison'
      ? {
          message:
            'No configured design reference was captured in this run. Run the referenced story or select a run that captured it.',
        }
      : {}),
    policy: { method: 'pixelmatch', threshold: 0.1, includeAA: false },
    summary,
    states,
    ...(crop ? { crop } : {}),
  };
}

export async function referenceCommand(
  name: string | undefined,
  flags: { project?: string; run?: string; json?: boolean; region?: string },
  { io = stdio }: Session = {},
  layoutCache?: ReferenceLayoutCache,
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
      includeLayout: Boolean(flags.json && !flags.region),
      includeOutlines: Boolean(flags.json && !flags.region),
      ...(layoutCache ? { layoutCache } : {}),
    });
    if (flags.json) {
      io.out(
        JSON.stringify({
          ...result,
          ...(result.crop
            ? {
                crop: {
                  regionId: result.crop.regionId,
                  box: result.crop.box,
                  scale: result.crop.scale,
                  width: result.crop.width,
                  height: result.crop.height,
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
      if (result.message) io.out(`${result.message}\n`);
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
            `- ${state.name} (${state.storyId}): ${state.status} — ${state.mismatchPixels} changed pixels (${state.mismatchPercent}%), ${state.regionCount} regions${state.regions.length ? `; largest region ${state.regions[0]!.id} (${state.regions[0]!.changedPixels ?? 'unknown'} changed pixels)` : ''}${state.visibleColors?.pairs[0] && state.visibleColors.pairs[0].pixels >= 32 && state.visibleColors.pairs[0].sharePercent >= 50 ? `; observed colors: target ${colorText(state.visibleColors.pairs[0].reference)}, current ${colorText(state.visibleColors.pairs[0].current)} (${state.visibleColors.pairs[0].sharePercent}% of sampled visible mismatches; not a CSS cause)` : ''}\n`,
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
    return result.outcome === 'no-comparison' || result.outcome === 'error'
      ? 3
      : result.outcome === 'fail'
        ? 1
        : 0;
  } catch (err) {
    io.err(`jux: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}
