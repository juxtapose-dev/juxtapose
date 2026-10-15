#!/usr/bin/env node
/* global document, getComputedStyle, devicePixelRatio */
// Investigation only: keep a browser alive and collect paired captures of one
// story. Observe layout/fonts AFTER all three screenshots so measurement cannot
// alter the first capture. No baselines, retries, or tolerant verdicts.
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Browser } from '../packages/core/dist/browser/browser.js';
import { resolveChrome } from '../packages/core/dist/browser/resolve.js';
import { captureStory } from '../packages/core/dist/capture/capture.js';
import { waitForPaint } from '../packages/core/dist/capture/settle.js';
import { StorybookPlatform } from '../packages/adapter-storybook/dist/index.js';
import { serveStatic } from '../packages/cli/dist/serve-static.js';

const [buildDir, storyId, countArg = '20', outputArg, mode = 'fresh'] =
  process.argv.slice(2);
const count = Number(countArg);
const workers = Number(process.env.JUX_TEXT_WORKERS ?? 1);
if (![1, 2, 3].includes(workers)) throw new Error('Workers must be 1, 2, or 3');
const experiment = process.env.JUX_TEXT_EXPERIMENT ?? 'baseline';
if (
  ![
    'baseline',
    'timing',
    'raw',
    'paint',
    'caret-paint',
    'delay',
    'warm-pixel',
    'warm-full',
  ].includes(experiment)
)
  throw new Error('Unknown text probe experiment');
if (
  !buildDir ||
  !storyId ||
  !Number.isInteger(count) ||
  count < 2 ||
  count > 200 ||
  !['fresh', 'shared', 'pulse'].includes(mode)
) {
  throw new Error(
    'Usage: node scripts/probe-text-rendering.mjs BUILD STORY [2..200 repeats] [output] [fresh|shared|pulse]',
  );
}
const out = outputArg
  ? path.resolve(outputArg)
  : mkdtempSync(path.join(os.tmpdir(), 'jux-text-probe-'));
mkdirSync(out, { recursive: true });
process.env.JUX_STATE_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'jux-text-state-'));
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const sharp = require('sharp');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const save = (name, value) =>
  writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
const chrome = resolveChrome();
if (!chrome) throw new Error('Install the pinned browser first');
const platform = new StorybookPlatform();
const story = (
  await platform.enumerate({
    buildDir: path.resolve(buildDir),
    projectRoot: process.cwd(),
  })
).find((s) => s.storyId === storyId);
if (!story) throw new Error(`Story not found: ${storyId}`);
const viewport = { width: 1280, height: 800 };
const server = await serveStatic(path.resolve(buildDir));
let browser;
const rows = [];
let reference;
let layoutReference;
async function pixels(image) {
  return sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
function delta(a, b) {
  if (a.info.width !== b.info.width || a.info.height !== b.info.height)
    return { dimensionsChanged: true };
  let changed = 0,
    maxChannelDelta = 0;
  let left = a.info.width,
    top = a.info.height,
    right = -1,
    bottom = -1;
  for (let i = 0; i < a.data.length; i += 4) {
    let different = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      different ||= d !== 0;
      maxChannelDelta = Math.max(maxChannelDelta, d);
    }
    if (different) {
      changed++;
      const x = (i / 4) % a.info.width,
        y = Math.floor(i / 4 / a.info.width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return {
    changedPixels: changed,
    percent: (100 * changed) / (a.info.width * a.info.height),
    maxChannelDelta,
    bounds: changed ? { left, top, right, bottom } : null,
  };
}
function observePage() {
  const rect = (r) => [r.x, r.y, r.width, r.height];
  const elements = [];
  const animations = [];
  const styles = (css) =>
    Object.fromEntries(
      [
        'color',
        'backgroundColor',
        'borderTopColor',
        'borderTopWidth',
        'opacity',
        'transitionProperty',
        'transitionDuration',
        'transitionDelay',
        'animationName',
        'animationDuration',
        'transform',
        'filter',
        'willChange',
      ].map((key) => [key, css[key]]),
    );
  const walk = (root, prefix) => {
    if (root.getAnimations) {
      for (const animation of root.getAnimations()) {
        animations.push({
          root: prefix,
          playState: animation.playState,
          currentTime: animation.currentTime,
          timing: animation.effect?.getComputedTiming(),
          target: animation.effect?.target?.localName,
        });
      }
    }
    for (const [index, el] of Array.from(root.children ?? []).entries()) {
      if (el.matches('script,style,link,meta,title')) continue;
      const key = `${prefix}/${el.localName}[${index}]`;
      const css = getComputedStyle(el);
      const text = Array.from(el.childNodes).filter(
        (n) => n.nodeType === 3 && n.textContent.trim(),
      );
      if ((text.length || el.matches('input,textarea')) && el.getClientRects().length) {
        elements.push({
          key,
          text: text.map((n) => n.textContent),
          value: el.value,
          bounds: rect(el.getBoundingClientRect()),
          font: css.font,
          family: css.fontFamily,
          weight: css.fontWeight,
          size: css.fontSize,
          lineHeight: css.lineHeight,
          letterSpacing: css.letterSpacing,
          color: css.color,
          styles: styles(css),
          placeholder: el.matches('input,textarea')
            ? styles(getComputedStyle(el, '::placeholder'))
            : undefined,
          transform: css.transform,
          ranges: text.map((n) => {
            const r = document.createRange();
            r.selectNodeContents(n);
            return Array.from(r.getClientRects(), rect);
          }),
        });
      }
      if (el.shadowRoot) walk(el.shadowRoot, `${key}#shadow`);
      walk(el, key);
    }
  };
  walk(document.documentElement, 'html');
  return {
    fontsStatus: document.fonts.status,
    fonts: Array.from(document.fonts, (f) => ({
      family: f.family,
      style: f.style,
      weight: f.weight,
      status: f.status,
    })),
    elements,
    animations,
    dpr: devicePixelRatio,
  };
}
try {
  browser = await Browser.launch({ executablePath: chrome.path });
  save('environment.json', {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    node: process.version,
    chrome,
    sharp: sharp.versions,
    viewport,
    mode,
    experiment,
    storyId,
    count,
    countMeaning: experiment === 'timing' ? 'per arm (four arms)' : 'total',
    workers,
    note: 'Fresh context per repetition; one persistent browser. Measurements follow all three screenshots. Reference is first completed capture, not necessarily pass 1. Open shadow roots covered; closed roots and iframe contents are not covered by geometry.',
  });
  let nextPass = 1;
  let lastPaintMs = 33;
  const arms =
    experiment === 'timing'
      ? ['baseline', 'paint', 'delay-matched', 'observe']
      : [experiment];
  const total = count * arms.length;
  async function runWorker() {
    while (nextPass <= total) {
      const pass = nextPass++;
      // Rotate assignments across workers and blocks; all arms share the runner.
      const block = Math.floor((pass - 1) / arms.length);
      const arm = arms[(((pass - 1) % arms.length) + block) % arms.length];
      let interventionMs = 0;
      let delayTargetMs;
      let beforeObservation;
      const start = performance.now();
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const screenshot = page.screenshot.bind(page);
        let originalPng;
        page.screenshot = async (options) => {
          if (!originalPng) {
            const interventionStart = performance.now();
            if (arm === 'delay-matched') {
              delayTargetMs = lastPaintMs;
              await new Promise((resolve) => setTimeout(resolve, delayTargetMs));
            }
            if (arm === 'observe') {
              beforeObservation = await page.evaluate(observePage);
              save(`${pass}-before.json`, beforeObservation);
            }
            if (arm === 'delay') await new Promise((resolve) => setTimeout(resolve, 100));
            if (arm === 'warm-pixel' || arm === 'warm-full') {
              await page.send('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: false,
                clip: {
                  x: 0,
                  y: 0,
                  width: arm === 'warm-pixel' ? 1 : viewport.width,
                  height: arm === 'warm-pixel' ? 1 : viewport.height,
                  scale: 1,
                },
              });
            }
            if (arm === 'raw') {
              if (options?.mask?.length)
                throw new Error('Raw experiment does not support masks');
              const { data } = await page.send('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: false,
                clip: {
                  x: 0,
                  y: 0,
                  width: viewport.width,
                  height: viewport.height,
                  scale: 1,
                },
              });
              originalPng = Buffer.from(data, 'base64');
              return originalPng;
            }
            if (arm === 'caret-paint') {
              await page.evaluate(() => {
                const visit = (root) => {
                  for (const el of root.querySelectorAll('*')) {
                    if (el.matches('input,textarea,[contenteditable]'))
                      el.style.setProperty('caret-color', 'transparent', 'important');
                    if (el.shadowRoot) visit(el.shadowRoot);
                  }
                };
                visit(document);
              });
            }
            if (arm === 'paint' || arm === 'caret-paint') {
              await waitForPaint(page);
              lastPaintMs = performance.now() - interventionStart;
            }
            interventionMs = performance.now() - interventionStart;
          }
          const image = await screenshot(options);
          originalPng ??= image;
          return image;
        };
        const snap = await captureStory(
          page,
          story,
          {
            platform,
            baseUrl: server.url,
            forceFreshRenderer: mode === 'fresh',
            forceResourceCache: mode === 'pulse',
            renderer: { shared: mode !== 'fresh' },
          },
          viewport,
        );
        if (!snap) throw new Error('Story was skipped');
        writeFileSync(path.join(out, `${pass}-original.png`), originalPng);
        const second = await page.screenshot();
        const third = await page.screenshot();
        writeFileSync(path.join(out, `${pass}-capture.webp`), snap.image);
        writeFileSync(path.join(out, `${pass}-repeat.png`), second);
        writeFileSync(path.join(out, `${pass}-third.png`), third);
        const observation = await page.evaluate(observePage);
        // CDP's actual font usage is stronger evidence than computed font-family.
        await page.send('DOM.enable');
        await page.send('CSS.enable');
        const { nodes } = await page.send('DOM.getFlattenedDocument', {
          depth: -1,
          pierce: true,
        });
        const fontUsage = [];
        const ids = new Set(
          nodes
            .filter((n) => n.nodeType === 3 && n.nodeValue.trim())
            .map((n) => n.parentId),
        );
        for (const nodeId of ids) {
          if (!nodeId) continue;
          const node = nodes.find((n) => n.nodeId === nodeId);
          if (['SCRIPT', 'STYLE', 'TITLE'].includes(node?.nodeName)) continue;
          try {
            const result = await page.send('CSS.getPlatformFontsForNode', { nodeId });
            fontUsage.push({
              nodeName: node?.nodeName,
              attributes: node?.attributes,
              ...result,
            });
          } catch (error) {
            fontUsage.push({ error: String(error) });
          }
        }
        save(`${pass}-observation.json`, { ...observation, fontUsage });
        const firstPixels = await pixels(snap.image),
          secondPixels = await pixels(second);
        const originalPixels = await pixels(originalPng);
        reference ??= firstPixels;
        const layoutHash = digest(JSON.stringify(observation));
        layoutReference ??= layoutHash;
        const row = {
          pass,
          arm,
          interventionMs,
          delayTargetMs,
          beforeMatchesAfter: beforeObservation
            ? JSON.stringify(beforeObservation) === JSON.stringify(observation)
            : undefined,
          hash: digest(snap.image),
          layoutHash,
          layoutMatchesFirst: layoutHash === layoutReference,
          versusFirst: delta(reference, firstPixels),
          encodingDelta: delta(originalPixels, firstPixels),
          samePageRepeat: delta(firstPixels, secondPixels),
          secondToThird: delta(secondPixels, await pixels(third)),
          elapsedMs: Math.round(performance.now() - start),
        };
        rows.push(row);
        rows.sort((a, b) => a.pass - b.pass);
        console.log(JSON.stringify(row));
        save('results.json', rows);
      } finally {
        await context.close();
      }
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: workers }, runWorker));
  const failed = outcomes.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
} finally {
  await browser?.close();
  await server.close();
}
console.log(`Evidence: ${out}`);
