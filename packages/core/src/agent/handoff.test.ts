import { describe, it, expect } from 'vitest';
import { buildHandoffPrompt, describeRegion, type HandoffPayload } from './handoff.js';

const base: HandoffPayload = {
  storyId: 'components-button--primary',
  storyTitle: 'Components/Button — Primary',
  status: 'fail',
  mismatchPercent: 3.72,
  mismatchPixels: 30474,
  changedRegions: [{ x: 412, y: 88, width: 120, height: 24 }],
  viewport: { width: 1280, height: 800 },
  componentPath: '/repo/src/Button.tsx',
  diffDataPath: '/repo/.juxtapose/runs/1/diffs/button.json',
  images: { baseline: 'b.webp', current: 'c.webp', diff: 'd.webp' },
  projectRoot: '/repo',
};

describe('buildHandoffPrompt', () => {
  it('leads with structured data, not images', () => {
    const out = buildHandoffPrompt(base);
    // The whole efficiency argument: data first, images as a fallback.
    expect(out.indexOf('What changed')).toBeLessThan(out.indexOf('Images'));
    expect(out).toContain('inspect only if the data above is insufficient');
  });

  it('includes the exact mismatch figures', () => {
    const out = buildHandoffPrompt(base);
    expect(out).toContain('"mismatchPercent": 3.72');
    expect(out).toContain('"mismatchPixels": 30474');
  });

  it('points at the machine-readable sidecar', () => {
    expect(buildHandoffPrompt(base)).toContain('/repo/.juxtapose/runs/1/diffs/button.json');
  });

  it('names the component and how to check its history', () => {
    const out = buildHandoffPrompt(base);
    expect(out).toContain('/repo/src/Button.tsx');
    expect(out).toContain('git log -p -- /repo/src/Button.tsx');
  });

  it('gives both approve and fix paths, and withholds auto-apply', () => {
    const out = buildHandoffPrompt(base);
    expect(out).toContain('jux approve --story components-button--primary');
    expect(out).toContain('Do not apply it without confirmation');
  });

  it('footers the project root so a wrong-repo session self-detects', () => {
    expect(buildHandoffPrompt(base)).toContain('Generated for `/repo`');
  });

  it('scales its suspicion to the magnitude of the change', () => {
    const tiny = buildHandoffPrompt({ ...base, mismatchPercent: 0.02 });
    expect(tiny).toContain('sub-pixel antialiasing');

    const huge = buildHandoffPrompt({ ...base, mismatchPercent: 42 });
    expect(huge).toContain('do not approve without understanding');
  });

  it('handles a new story with no baseline', () => {
    const out = buildHandoffPrompt({ ...base, status: 'new' });
    expect(out).toContain('no baseline yet');
    expect(out).toContain('jux approve');
  });

  it('explains staleness as provenance, not pixels', () => {
    const out = buildHandoffPrompt({ ...base, status: 'stale' });
    expect(out).toContain('not an ancestor');
    expect(out).toContain('Re-run');
  });

  it('truncates a pathological region list', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i, width: 2, height: 2 }));
    const out = buildHandoffPrompt({ ...base, changedRegions: many });
    expect(out).toContain('and 38 more');
  });
});

describe('describeRegion', () => {
  const vp = { width: 1200, height: 900 };

  it('locates a region in words as well as coordinates', () => {
    const d = describeRegion({ x: 10, y: 10, width: 50, height: 50 }, vp);
    expect(d).toContain('(10, 10) 50×50px');
    expect(d).toContain('top-left');
  });

  it('identifies each corner and the centre', () => {
    expect(describeRegion({ x: 1100, y: 10, width: 10, height: 10 }, vp)).toContain('top-right');
    expect(describeRegion({ x: 10, y: 850, width: 10, height: 10 }, vp)).toContain('bottom-left');
    expect(describeRegion({ x: 590, y: 440, width: 10, height: 10 }, vp)).toContain('middle-center');
  });

  it('reports area as a fraction of the viewport', () => {
    // 600x450 = 270000 of 1080000 = 25%
    expect(describeRegion({ x: 0, y: 0, width: 600, height: 450 }, vp)).toContain('25% of viewport');
  });
});
