#!/usr/bin/env node
// Serial desktop diagnostic, not an end-to-end throughput benchmark.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform as osPlatform, arch } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Browser } from '../packages/core/dist/browser/browser.js';
import { resolveChrome } from '../packages/core/dist/browser/resolve.js';
import { captureStory } from '../packages/core/dist/capture/capture.js';
import { StorybookPlatform } from '../packages/adapter-storybook/dist/index.js';
import { serveStatic } from '../packages/cli/dist/serve-static.js';

const buildDir = path.resolve(process.argv[2] ?? 'examples/storybook/storybook-profile');
const passes = Number(process.argv[3] ?? 3);
if (!Number.isInteger(passes) || passes < 1 || passes > 10)
  throw new Error('Use 1..10 measured passes');
const out = mkdtempSync(path.join(tmpdir(), 'jux-capture-calls-'));
process.env.JUX_STATE_DIR = path.join(out, 'state');
const platform = new StorybookPlatform();
const stories = (
  await platform.enumerate({ buildDir, projectRoot: process.cwd() })
).filter((s) => s.storyId.startsWith('profile--'));
if (stories.length !== 24) throw new Error('Expected the 24 controlled stories');
const server = await serveStatic(buildDir);
let browser;
const samples = [],
  references = new Map();
console.log(out);
try {
  browser = await Browser.launch({ executablePath: resolveChrome().path });
  const viewport = { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  let current,
    inScreenshot = false;
  const measure = async (name, work, bucket = 'screenshotCalls') => {
    const start = performance.now();
    try {
      return await work();
    } finally {
      if (current)
        current[bucket][name] = (current[bucket][name] ?? 0) + performance.now() - start;
    }
  };
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async (...args) => {
    inScreenshot = true;
    try {
      return await screenshot(...args);
    } finally {
      inScreenshot = false;
    }
  };
  const evaluate = page.evaluate.bind(page);
  page.evaluate = (...args) => {
    const code = String(args[0]);
    if (!inScreenshot) {
      const name =
        code.includes('__juxIdle') && code.includes('freeze')
          ? 'shadowFreeze'
          : code.includes('__juxIdle.reset()')
            ? 'idleReset'
            : undefined;
      return name
        ? measure(name, () => evaluate(...args), 'setupCalls')
        : evaluate(...args);
    }
    const name = code.includes('collectRoots')
      ? 'prepare'
      : code.includes('document.fonts.ready')
        ? 'fonts'
        : code.includes('__juxCleanupScreenshot')
          ? 'cleanup'
          : 'mask';
    return measure(name, () => evaluate(...args));
  };
  const send = page.send.bind(page);
  page.send = (method, ...args) =>
    inScreenshot && ['Page.getLayoutMetrics', 'Page.captureScreenshot'].includes(method)
      ? measure(method, () => send(method, ...args))
      : method === 'Runtime.getIsolateId'
        ? measure('rendererIdentity', () => send(method, ...args), 'setupCalls')
        : send(method, ...args);
  const addStyleTag = page.addStyleTag.bind(page);
  page.addStyleTag = (...args) =>
    measure('freezeStylesheet', () => addStyleTag(...args), 'setupCalls');
  for (let pass = 0; pass <= passes; pass++) {
    for (const story of pass % 2 ? [...stories].reverse() : stories) {
      current = {
        storyId: story.storyId,
        pass,
        screenshotCalls: {},
        setupCalls: {},
        phases: {},
      };
      let phase, phaseStart;
      const markPhase = (next) => {
        const now = performance.now();
        if (phase)
          current.phases[phase] = (current.phases[phase] ?? 0) + now - phaseStart;
        phase = next;
        phaseStart = now;
      };
      const snapshot = await captureStory(
        page,
        story,
        {
          platform,
          baseUrl: server.url,
          renderer: { shared: true },
          forceFreshRenderer: pass === 0,
          onPhase: markPhase,
        },
        viewport,
      );
      markPhase(undefined);
      if (!snapshot?.image || !snapshot.structure) throw new Error('Missing capture');
      const identity = {
        image: createHash('sha256').update(snapshot.image).digest('hex'),
        structure: JSON.stringify(snapshot.structure),
      };
      if (pass === 0) references.set(story.storyId, identity);
      else {
        const ref = references.get(story.storyId);
        if (ref.image !== identity.image || ref.structure !== identity.structure)
          throw new Error(`Capture changed: ${story.storyId}`);
        current.timings = snapshot.timings;
        samples.push(current);
      }
      current = undefined;
    }
  }
  const mean = (key) => {
    const names = new Set(samples.flatMap((s) => Object.keys(s[key])));
    return Object.fromEntries(
      [...names].map((name) => [
        name,
        samples.reduce((sum, s) => sum + (s[key][name] ?? 0), 0) / samples.length,
      ]),
    );
  };
  const summary = {
    buildDir,
    node: process.version,
    browser: browser.version(),
    platform: `${osPlatform()} ${arch()}`,
    cpu: cpus()[0]?.model,
    passes,
    captures: samples.length,
    viewport,
    parity: true,
    screenshotMeanMs: mean('screenshotCalls'),
    phaseMeanMs: mean('phases'),
    setupMeanMs: mean('setupCalls'),
    reportedPhaseMeanMs: mean('timings'),
    note: 'Single page; diagnostic wrappers add overhead. Screenshot subcalls are inside the screenshot phase, not additive to it. First pass is an excluded fresh-renderer reference.',
  };
  writeFileSync(
    path.join(out, 'results.json'),
    JSON.stringify({ summary, samples }, null, 2) + '\n',
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
