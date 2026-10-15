#!/usr/bin/env node
// Diagnostic only. No baselines changed; one browser/page at a time.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Browser } from '../packages/core/dist/browser/browser.js';
import { resolveChrome } from '../packages/core/dist/browser/resolve.js';
import { captureStory } from '../packages/core/dist/capture/capture.js';
import {
  STRUCTURE_PROPS,
  normalizeStructure,
} from '../packages/core/dist/capture/structure.js';
import { StorybookPlatform } from '../packages/adapter-storybook/dist/index.js';
import { serveStatic } from '../packages/cli/dist/serve-static.js';

const [buildArg = 'examples/storybook/storybook-profile', countArg = '10', outputArg] =
  process.argv.slice(2);
const count = Number(countArg);
if (!Number.isInteger(count) || count < 3 || count > 100)
  throw new Error('Use 3..100 passes');
const buildDir = path.resolve(buildArg);
const output = outputArg ?? mkdtempSync(path.join(os.tmpdir(), 'jux-extraction-probe-'));
mkdirSync(output, { recursive: true });
process.env.JUX_STATE_DIR ??= mkdtempSync(
  path.join(os.tmpdir(), 'jux-extraction-state-'),
);
const props = [...STRUCTURE_PROPS, 'visibility'];
const groups = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ],
};
const replacements = new Map(
  Object.entries(groups).flatMap(([short, names]) => names.map((name) => [name, short])),
);
const compact = [...new Set(props.map((name) => replacements.get(name) ?? name))];
function expand(raw) {
  const strings = raw.strings;
  const indices = new Map(strings.map((s, i) => [s, i]));
  const intern = (value) => {
    if (!indices.has(value)) {
      indices.set(value, strings.length);
      strings.push(value);
    }
    return indices.get(value);
  };
  const expandedValues = new Map();
  const columns = props.map((name) => {
    const short = replacements.get(name);
    return {
      index: compact.indexOf(short ?? name),
      side: short ? groups[short].indexOf(name) : -1,
    };
  });
  const expandValue = (index) => {
    let expanded = expandedValues.get(index);
    if (expanded) return expanded;
    const value = strings[index];
    const values = value?.trim().split(/\s+/);
    if (
      !values?.length ||
      values.length > 4 ||
      values.some((v) => !/^-?[\d.]+px$/.test(v))
    )
      throw new Error(`Unsupported shorthand: ${value}`);
    const [a, b = a, c = a, d = b] = values;
    expanded = [a, b, c, d].map(intern);
    expandedValues.set(index, expanded);
    return expanded;
  };
  for (const doc of raw.documents) {
    doc.layout.styles = doc.layout.styles.map((row) => {
      if (!row.length) return [];
      return columns.map(({ index, side }) =>
        side < 0 ? row[index] : expandValue(row[index])[side],
      );
    });
  }
  return raw;
}
const parse = JSON.parse;
let lastParse;
// Probe-local hook: measure the actual CDP response parse, not re-serialized JSON.

const platform = new StorybookPlatform();
const stories = await platform.enumerate({ buildDir, projectRoot: process.cwd() });
const selected = stories.filter((s) =>
  /profile--(nested|images|forms|typography|cards|tables|charts|async)-(small|medium|large)$/.test(
    s.storyId,
  ),
);
if (!selected.length) throw new Error('No controlled profile stories found');
const server = await serveStatic(buildDir);
let browser;
let browserVersion;
const results = [];
const viewport = { width: 1280, height: 800 };
try {
  JSON.parse = function (text, ...args) {
    const start = performance.now();
    const result = parse(text, ...args);
    const elapsed = performance.now() - start;
    if (result?.result?.documents && result?.result?.strings)
      lastParse = { parseMs: elapsed, bytes: Buffer.byteLength(text) };
    return result;
  };
  browser = await Browser.launch({ executablePath: resolveChrome().path });
  browserVersion = browser.version();
  for (const story of selected) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      await captureStory(
        page,
        story,
        { platform, baseUrl: server.url, structure: false, renderer: { shared: true } },
        viewport,
      );
      const beforeImage = await page.screenshot();
      let reference;
      const rows = [];
      for (let pass = -2; pass < count; pass++) {
        const arms = ['full', 'compact', 'visibility'];
        const offset = (pass + 2) % arms.length;
        for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)]) {
          lastParse = undefined;
          const start = performance.now();
          const raw = await page.send('DOMSnapshot.captureSnapshot', {
            computedStyles:
              arm === 'full' ? props : arm === 'compact' ? compact : ['visibility'],
            includePaintOrder: true,
          });
          const roundtripMs = performance.now() - start;
          const parsed = lastParse;
          if (!parsed) throw new Error('Missing CDP parse measurement');
          let normalizeMs = 0,
            expandMs = 0,
            parity;
          if (arm !== 'visibility') {
            const tExpand = performance.now();
            if (arm === 'compact') expand(raw);
            expandMs = performance.now() - tExpand;
            const tNormalize = performance.now();
            const normalized = normalizeStructure(raw, viewport);
            normalizeMs = performance.now() - tNormalize;
            const json = JSON.stringify(normalized);
            reference ??= json;
            parity = reference === json;
            if (!parity)
              throw new Error(`${story.storyId}: exact structure mismatch (${arm})`);
          }
          if (pass >= 0)
            rows.push({
              arm,
              pass,
              roundtripMs,
              ...parsed,
              expandMs,
              normalizeMs,
              parity,
            });
        }
      }
      const pixelsStable = beforeImage.equals(await page.screenshot());
      if (!pixelsStable) throw new Error(`${story.storyId}: pixels changed during probe`);
      results.push({ story: story.storyId, pixelsStable, rows });
      console.error(`${story.storyId}: ${count} passes, exact full/compact parity`);
    } finally {
      await context.close();
    }
  }
} finally {
  JSON.parse = parse;
  await browser?.close();
  await server.close();
}
writeFileSync(
  path.join(output, 'results.json'),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      browserVersion,
      buildDir,
      cpu: os.cpus()[0]?.model,
      viewport,
      count,
      properties: { full: props, compact },
      note: 'One settled page per story, rotated arms, two warmups. Visibility is diagnostic only and drops structural coverage. No end-to-end speedup claim.',
      results,
    },
    null,
    2,
  ),
);
console.log(output);
