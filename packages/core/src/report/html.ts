// A single self-contained report.html.
//
// The constraint that shapes everything here: it must work opened from
// `file://`, because that is how someone downloads a CI artifact and looks at
// it. No external stylesheet, no script src, no sibling image directory —
// images inline as data URIs and the whole thing is one file you can email.
//
// This complements rather than duplicates the addon panel. The panel is for
// local review with a dev server running; this is for a reviewer looking at a
// pull request who has checked nothing out.

import type { RunReport, DiffResult } from '../types.js';
import { formatPercent } from './format.js';

export interface HtmlReportOptions {
  report: RunReport;
  /** storyId -> image bytes. Missing entries are expected: a new story has no
   *  baseline, a passing one needs no diff. */
  images: Map<string, { baseline?: Buffer; current?: Buffer; diff?: Buffer }>;
}

export function buildHtmlReport({ report, images }: HtmlReportOptions): string {
  const needsReview = report.results.filter(
    (r) => r.status === 'fail' || r.status === 'new' || r.status === 'stale',
  );
  const s = report.summary;

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>juxtapose — ${escapeHtml(report.branch)} @ ${escapeHtml(report.commitSha.slice(0, 7))}</title>
<style>${STYLE}</style>

<header>
  <h1>${needsReview.length === 0 ? 'Visual tests passed' : 'Visual changes need review'}</h1>
  <dl>
    ${stat('pass', s.pass)}
    ${s.fail ? stat('changed', s.fail, 'bad') : ''}
    ${s.new ? stat('new', s.new, 'warn') : ''}
    ${s.stale ? stat('stale', s.stale, 'warn') : ''}
    ${s.skip ? stat('skipped', s.skip) : ''}
  </dl>
  <p class="meta">
    ${escapeHtml(report.branch)} ·
    <code>${escapeHtml(report.commitSha.slice(0, 7))}</code> ·
    ${report.capturedCount}/${report.totalCount} captured ·
    ${(report.durationMs / 1000).toFixed(1)}s
  </p>
</header>

${
  needsReview.length === 0
    ? `<p class="empty">Every captured story matches its approved baseline.</p>`
    : needsReview.map((r) => storySection(r, images.get(r.storyId))).join('\n')
}

<script>${SCRIPT}</script>
`;
}

function stat(label: string, value: number, tone = ''): string {
  return `<div class="${tone}"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function storySection(
  result: DiffResult,
  imgs: { baseline?: Buffer; current?: Buffer; diff?: Buffer } | undefined,
): string {
  const baseline = dataUri(imgs?.baseline);
  const current = dataUri(imgs?.current);
  const diff = dataUri(imgs?.diff);

  // A new story has no baseline, so there is nothing to compare — show the
  // capture alone rather than an empty half. Same reasoning as the panel:
  // controls that compare nothing read as broken.
  const comparable = Boolean(baseline && current);

  return `
<section>
  <h2>
    <span class="badge ${result.status}">${statusLabel(result.status)}</span>
    ${escapeHtml(result.storyId)}
    ${result.status === 'fail' ? `<span class="pct">${escapeHtml(formatPercent(result.mismatchPercent))} changed</span>` : ''}
  </h2>
  ${result.error ? `<p class="error">${escapeHtml(result.error)}</p>` : ''}
  ${
    comparable
      ? `
  <div class="tabs">
    <button data-mode="sxs" class="on">Side by side</button>
    <button data-mode="slider">Slider</button>
    ${diff ? `<button data-mode="diff">Diff</button>` : ''}
  </div>

  <div class="views">
    <div class="view sxs on">
      <figure><figcaption>Baseline</figcaption><img src="${baseline}" alt="baseline"></figure>
      <figure><figcaption>Current</figcaption><img src="${current}" alt="current"></figure>
    </div>

    <div class="view slider">
      <div class="wipe" style="--pos:50%">
        <img src="${baseline}" alt="baseline">
        <img class="over" src="${current}" alt="current">
        <div class="handle"></div>
      </div>
      <input type="range" min="0" max="100" value="50" aria-label="Wipe between baseline and current">
    </div>

    ${diff ? `<div class="view diff"><img src="${diff}" alt="diff overlay"></div>` : ''}
  </div>`
      : current
        ? `<div class="single"><img src="${current}" alt="capture"></div>`
        : `<p class="error">No capture available for this story.</p>`
  }
</section>`;
}

/**
 * Inline an image.
 *
 * Data URIs are what make the file portable — a sibling images/ directory
 * breaks the moment someone moves or emails the html. The cost is roughly 33%
 * inflation from base64, acceptable for a CI artifact.
 */
function dataUri(bytes: Buffer | undefined): string | null {
  return bytes ? `data:image/webp;base64,${bytes.toString('base64')}` : null;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'fail':
      return 'changed';
    case 'new':
      return 'no baseline';
    case 'stale':
      return 'stale';
    default:
      return status;
  }
}

/** Escape anything interpolated into markup. Story ids come from the platform
 *  and are not ours to trust. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
:root {
  --fg: #0f172a; --muted: #64748b; --line: #e2e8f0; --bg: #fff;
  --bad: #dc2626; --warn: #d97706;
  font-family: system-ui, -apple-system, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --fg: #e2e8f0; --muted: #94a3b8; --line: #334155; --bg: #0f172a; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 24px; max-width: 1200px;
       color: var(--fg); background: var(--bg); }
h1 { font-size: 20px; margin: 0 0 12px; }
dl { display: flex; gap: 20px; margin: 0 0 8px; padding: 0; }
dl div { display: flex; gap: 6px; align-items: baseline; }
dt { color: var(--muted); font-size: 13px; }
dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
dl .bad dd { color: var(--bad); } dl .warn dd { color: var(--warn); }
.meta { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
.empty { color: var(--muted); }
section { border-top: 1px solid var(--line); padding: 20px 0; }
h2 { font-size: 15px; font-weight: 600; display: flex; align-items: center;
     gap: 10px; margin: 0 0 12px; }
.badge { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
         padding: 2px 8px; border-radius: 999px; color: #fff; }
.badge.fail { background: var(--bad); }
.badge.new, .badge.stale { background: var(--warn); }
.pct { color: var(--muted); font-weight: 400; font-size: 13px; }
.error { color: var(--bad); font-size: 13px; margin: 0 0 12px; }
.tabs { display: flex; gap: 4px; margin-bottom: 12px; }
.tabs button { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
               border: 1px solid var(--line); background: transparent;
               color: var(--muted); border-radius: 4px; }
.tabs button.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.view { display: none; }
.view.on { display: block; }
.view.sxs.on { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
figure { margin: 0; }
figcaption { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
             color: var(--muted); margin-bottom: 6px; }
img { max-width: 100%; height: auto; display: block; border: 1px solid var(--line); }
.single img { max-width: 640px; }
.wipe { position: relative; display: inline-block; max-width: 100%; }
.wipe .over { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--pos)); }
.wipe .handle { position: absolute; top: 0; bottom: 0; left: var(--pos);
                width: 2px; background: var(--bad); pointer-events: none; }
input[type=range] { width: 100%; margin-top: 8px; }
`;

/**
 * Tab switching and the wipe slider.
 *
 * Inline and dependency-free on purpose: a `file://` page cannot load anything
 * external, and a report needing a build step to view defeats the point of
 * being an artifact.
 */
const SCRIPT = `
document.querySelectorAll('section').forEach(function (section) {
  section.querySelectorAll('.tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      section.querySelectorAll('.tabs button').forEach(function (b) {
        b.classList.toggle('on', b === btn);
      });
      section.querySelectorAll('.view').forEach(function (v) {
        v.classList.toggle('on', v.classList.contains(btn.dataset.mode));
      });
    });
  });

  var range = section.querySelector('input[type=range]');
  var wipe = section.querySelector('.wipe');
  if (range && wipe) {
    range.addEventListener('input', function () {
      wipe.style.setProperty('--pos', range.value + '%');
    });
  }
});
`;
