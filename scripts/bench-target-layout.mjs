// Offline only. Decode once, then measure the raw-RGBA analysis separately.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fromPng, matchLayout } from '../packages/core/dist/diff/target-layout/index.js';
import { decodeStructure, styleReader } from '../packages/core/dist/capture/structure.js';
const sharp = createRequire(new URL('../packages/core/package.json', import.meta.url))(
  'sharp',
);
const [manifest, output] = process.argv.slice(2);
if (!manifest || !output) throw Error('Expected cases.json and a new results.json');
const corpus = JSON.parse(await readFile(manifest, 'utf8'));
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
  ];
const decode = async (file) => {
  const { data, info } = await sharp(await readFile(file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
const rect = (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h });
const edgeError = (a, b) =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - b.x - b.width),
    Math.abs(a.y + a.height - b.y - b.height),
  );
const rows = [];
for (const c of corpus.cases) {
  const start = performance.now();
  const [target, current, targetStructure, currentStructure] = await Promise.all([
    decode(c.reference),
    decode(c.current),
    readFile(c.targetStructure).then(decodeStructure),
    readFile(c.currentStructure).then(decodeStructure),
  ]);
  const decodeMs = performance.now() - start;
  const analyze = () => matchLayout(fromPng(target), fromPng(current), currentStructure);
  const firstStart = performance.now();
  analyze();
  const firstAnalysisMs = performance.now() - firstStart;
  for (let i = 0; i < 3; i++) analyze();
  const times = [];
  let result;
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    result = analyze();
    times.push(performance.now() - start);
  }
  const byPath = new Map(targetStructure.elements.map((el) => [el.path, el]));
  const ids = (elements) => {
    const counts = new Map();
    for (const el of elements) if (el.id) counts.set(el.id, (counts.get(el.id) ?? 0) + 1);
    return new Map(
      elements.filter((el) => el.id && counts.get(el.id) === 1).map((el) => [el.id, el]),
    );
  };
  const targetIds = ids(targetStructure.elements),
    currentIds = ids(currentStructure.elements);
  const targetFor = (el) =>
    el?.id
      ? currentIds.has(el.id)
        ? targetIds.get(el.id)
        : undefined
      : byPath.get(el?.path);
  const eligible = currentStructure.elements.filter((el) => {
    const prior = targetFor(el);
    return (
      prior &&
      edgeError(rect(prior.rect), rect(el.rect)) > 2 &&
      [prior, el].every(
        (e) =>
          e.rect.x >= 0 &&
          e.rect.y >= 0 &&
          e.rect.x + e.rect.w <= current.width &&
          e.rect.y + e.rect.h <= current.height,
      )
    );
  });
  const observations = result.matches.map((match) => {
    const expected = targetFor(match.element);
    const index = expected ? targetStructure.elements.indexOf(expected) : -1;
    const style = styleReader(targetStructure);
    const border = (side) =>
      index >= 0 ? Number.parseFloat(style(index, `border-${side}-width`)) || 0 : 0;
    const outer = expected ? rect(expected.rect) : null;
    const inner = outer
      ? {
          x: outer.x + border('left'),
          y: outer.y + border('top'),
          width: outer.width - border('left') - border('right'),
          height: outer.height - border('top') - border('bottom'),
        }
      : null;
    return {
      ...match,
      expectedElement: expected ? { id: expected.id, path: expected.path } : null,
      correct:
        !!expected &&
        Math.min(edgeError(match.targetBox, outer), edgeError(match.targetBox, inner)) <=
          1,
    };
  });
  rows.push({
    name: c.name,
    width: current.width,
    height: current.height,
    decodeMs,
    firstAnalysisMs,
    analysisP50: percentile(times, 0.5),
    analysisP95: percentile(times, 0.95),
    truePositives: observations.filter((o) => o.correct).length,
    falsePositives: observations.filter((o) => !o.correct).length,
    eligibleGeometryChanges: eligible.length,
    recalledGeometryChanges: new Set(
      observations
        .filter((o) => o.correct && eligible.some((el) => el.path === o.element.path))
        .map((o) => o.element.path),
    ).size,
    abstained: result.abstained,
    analysisStatus: result.status,
    abstentionReason: result.reason,
    observations,
  });
}
// Padding preserves UI pixels and DOM coordinates while testing a 4 MP extent.
const sample = corpus.cases.find((c) => c.name.includes('padding')) ?? corpus.cases[0];
const [a, b, s] = await Promise.all([
  decode(sample.reference),
  decode(sample.current),
  readFile(sample.currentStructure).then(decodeStructure),
]);
const pad = (image) => {
  const data = new Uint8Array(2000 * 2000 * 4).fill(255);
  for (let y = 0; y < image.height; y++)
    data.set(
      image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      y * 2000 * 4,
    );
  return { data, width: 2000, height: 2000 };
};
const aa = pad(a),
  bb = pad(b),
  ss = { ...s, viewport: { width: 2000, height: 2000 } };
const times = [];
for (let i = 0; i < 23; i++) {
  const start = performance.now();
  matchLayout(fromPng(aa), fromPng(bb), ss);
  if (i >= 3) times.push(performance.now() - start);
}
const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
const sourceHashes = {};
for (const file of [
  'scripts/bench-target-layout.mjs',
  'packages/core/src/diff/target-layout/index.ts',
  'packages/core/src/diff/target-layout/segment.ts',
  'packages/core/src/diff/target-layout/match.ts',
]) {
  sourceHashes[file] = createHash('sha256')
    .update(await readFile(new URL('../' + file, import.meta.url)))
    .digest('hex');
}
const report = {
  schema: 'jux.target-layout-offline/v2',
  environment: {
    node: process.version,
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    platform: process.platform,
    arch: process.arch,
  },
  sourceHashes,
  protocol: {
    warmups: 3,
    repeats: 20,
    oneCore: true,
    decodeExcludedFromAnalysis: true,
    provenance: 'actual native captures plus preserved-pixel 4MP padding; no paid models',
    precisionRule:
      'current element uniquely maps to actual outer or computed border-inset rectangle; target paint box must agree with same target DOM identity (unique ID preferred, otherwise path) outer or border-inset rectangle within 1px raster rounding; unverified reports count false positives',
    recallDenominator:
      'all visible same-identity DOM rectangles changed by >2px; unique ID preferred over ancestor-sensitive paths; includes elements with no separable flat fill',
  },
  summary: {
    reported: total('truePositives') + total('falsePositives'),
    truePositives: total('truePositives'),
    falsePositives: total('falsePositives'),
    eligibleGeometryChanges: total('eligibleGeometryChanges'),
    recalledGeometryChanges: total('recalledGeometryChanges'),
    precision:
      total('truePositives') / (total('truePositives') + total('falsePositives')) || null,
    recall: total('recalledGeometryChanges') / total('eligibleGeometryChanges') || 0,
  },
  fourMegapixel: {
    kind: 'padded real UI',
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
  },
  rows,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    summary: report.summary,
    fourMegapixel: report.fourMegapixel,
    worstP95: Math.max(...rows.map((r) => r.analysisP95)),
  }),
);
