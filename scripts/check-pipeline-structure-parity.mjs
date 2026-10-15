#!/usr/bin/env node
// node scripts/check-pipeline-structure-parity.mjs PROFILE_DIRECTORY [OUTPUT_JSON]
// Compares complete decoded sidecars against the baseline fresh reference.
// Resolves relocated evidence via arm and run ID; never reads original runDir.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
const dir = path.resolve(process.argv[2]);
const samples = JSON.parse(fs.readFileSync(path.join(dir, 'samples.json')));
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json')));
const reference = samples.find((s) => s.arm === 'baseline' && s.reference);
if (!reference) throw Error('Missing baseline fresh reference');
const canonical = (v) =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v !== null && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v);
const hashStructure = (x) =>
  createHash('sha256')
    .update(
      canonical(
        x.elements.map((e) =>
          Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'external')),
        ),
      ),
    )
    .digest('hex');
const load = (s, id) => {
  if (!['baseline', 'candidate'].includes(s.arm) || !/^[a-zA-Z0-9_-]+$/.test(id))
    throw Error('Unexpected arm/story ID');
  const file = path.join(
    dir,
    s.arm,
    '.juxtapose/runs',
    path.basename(s.runDir),
    'images',
    id + '-current.structure.json.gz',
  );
  const obj = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  if (obj.schema !== 'juxtapose.structure/v1' || !Array.isArray(obj.elements))
    throw Error('Invalid structure schema: ' + file);
  return obj;
};
const failures = [];
const refs = new Map();
for (const r of reference.report.results) {
  const x = load(reference, r.storyId);
  if (hashStructure(x) !== x.structureHash)
    failures.push({ storyId: r.storyId, error: 'Reference structure hash invalid' });
  refs.set(r.storyId, x);
}
if (refs.size !== 120) throw Error('Expected 120 reference stories');
const measured = samples.filter((s) => s.measured);
const counts = { baseline: 0, candidate: 0 };
let comparisons = 0;
for (const s of measured) {
  const seen = new Set();
  for (const r of s.report.results) {
    try {
      if (!refs.has(r.storyId) || seen.has(r.storyId))
        throw Error('Unknown/duplicate story ID');
      seen.add(r.storyId);
      const x = load(s, r.storyId);
      const validHash = hashStructure(x) === x.structureHash;
      const equal = isDeepStrictEqual(x, refs.get(r.storyId));
      comparisons++;
      counts[s.arm]++;
      if (!validHash || !equal)
        failures.push({
          arm: s.arm,
          label: s.label,
          storyId: r.storyId,
          validHash,
          equal,
        });
    } catch (err) {
      failures.push({
        arm: s.arm,
        label: s.label,
        storyId: r.storyId,
        error: String(err),
      });
    }
  }
  if (seen.size !== 120)
    failures.push({ arm: s.arm, label: s.label, error: 'Expected 120 unique stories' });
}
for (const arm of ['baseline', 'candidate'])
  if (counts[arm] !== 120 * summary.metadata.passes)
    failures.push({
      arm,
      error: 'Measured capture count differs from configured passes',
    });
const evidence = {
  profileDirectory: dir,
  platform: summary.metadata.platform,
  method:
    'Deep strict equality of complete decompressed structure objects against baseline fresh reference; independently verify SHA-256 canonical elements excluding external per production hash contract. No fields excluded from object comparison.',
  referenceStories: refs.size,
  measuredRuns: measured.length,
  comparisons,
  counts,
  failures,
  passed: failures.length === 0,
};
const json = JSON.stringify(evidence, null, 2) + '\n';
if (process.argv[3]) fs.writeFileSync(process.argv[3], json);
console.log(json);
if (failures.length) process.exitCode = 1;
