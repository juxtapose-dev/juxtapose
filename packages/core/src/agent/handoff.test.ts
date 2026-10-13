import { readFileSync } from 'node:fs';
import path from 'node:path';
import { structuralDiff } from '../diff/structural.js';
import type { ChangedRegion, StructureSnapshot } from '../types.js';
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

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../diff/__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as {
  cases: Record<
    string,
    {
      structure: StructureSnapshot;
      pixels: {
        mismatchPixels: number;
        changedRegions: ChangedRegion[];
        dimensionMismatch: boolean;
      };
    }
  >;
};

describe('buildHandoffPrompt', () => {
  it('leads with structured data, not images', () => {
    const out = buildHandoffPrompt(base);
    // The whole efficiency argument: data first, images as a fallback.
    expect(out.indexOf('What changed')).toBeLessThan(out.indexOf('If still unsure'));
    expect(out).toContain('## If still unsure');
  });

  it('ends with the crops command before the image paths', () => {
    const out = buildHandoffPrompt({
      ...base,
      cropsCommand: "jux diff '/repo/.juxtapose/baselines/b.webp' /repo/c.webp --crops",
    });
    const footer = out.slice(out.indexOf('## If still unsure'));
    expect(footer).toContain(
      "`jux diff '/repo/.juxtapose/baselines/b.webp' /repo/c.webp --crops`",
    );
    expect(footer.indexOf('--crops')).toBeLessThan(footer.indexOf('- baseline:'));
    const bare = buildHandoffPrompt(base);
    expect(bare).toContain('## If still unsure');
    expect(bare).not.toContain('--crops');
  });

  it('includes the exact mismatch figures', () => {
    const out = buildHandoffPrompt(base);
    expect(out).toContain('"mismatchPercent": 3.72');
    expect(out).toContain('"mismatchPixels": 30474');
  });

  it('points at the machine-readable sidecar', () => {
    expect(buildHandoffPrompt(base)).toContain(
      '/repo/.juxtapose/runs/1/diffs/button.json',
    );
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
    const many = Array.from({ length: 50 }, (_, i) => ({
      x: i,
      y: i,
      width: 2,
      height: 2,
    }));
    const out = buildHandoffPrompt({ ...base, changedRegions: many });
    expect(out).toContain('and 38 more');
  });

  it('leads with the cause when the run traced one', () => {
    const v = structuralDiff({
      baseline: fixture.cases.noop.structure,
      current: fixture.cases.color.structure,
      imagesIdentical: false,
      pixels: fixture.cases.color.pixels,
      escalate: { command: 'jux handoff x' },
      cause: {
        kind: 'in-closure',
        files: [
          { path: 'src/tokens.css', distance: 2 },
          { path: 'src/Button.tsx', distance: 1 },
        ],
      },
    });
    const out = buildHandoffPrompt({ ...base, structural: v });
    expect(out.indexOf('## Why')).toBeLessThan(
      out.indexOf('## What changed (structure)'),
    );
    expect(out).toContain('`src/tokens.css` (2 imports away)');
    expect(out).toContain('`src/Button.tsx` (1 import away)');
    const none = buildHandoffPrompt({
      ...base,
      structural: { ...v, cause: { kind: 'none-in-closure', files: [] } },
    });
    expect(none).toContain(
      "No changed file appears in this story's traced imports. The cause is likely outside your diff",
    );
    const unknown = buildHandoffPrompt({
      ...base,
      structural: { ...v, cause: { kind: 'unknown', files: [] } },
    });
    // Ruling 10: the handoff says why it cannot say; the CLI list stays quiet.
    expect(unknown).toContain('## Why');
    expect(unknown).toContain(
      "Cause unknown: this build doesn't expose every changed file's place in the story's imports, so nothing can be inferred from it.",
    );
    // The cause does not depend on structure: with no baseline sidecar the
    // structure section is replaced by a "re-approve" note, and `## Why` stays.
    const noStructure = buildHandoffPrompt({
      ...base,
      structural: { ...v, deltas: [], flags: ['no-baseline-structure'] },
    });
    expect(noStructure).toContain('## Why');
    expect(noStructure).toContain('No structure snapshot for the baseline');
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
    expect(describeRegion({ x: 1100, y: 10, width: 10, height: 10 }, vp)).toContain(
      'top-right',
    );
    expect(describeRegion({ x: 10, y: 850, width: 10, height: 10 }, vp)).toContain(
      'bottom-left',
    );
    expect(describeRegion({ x: 590, y: 440, width: 10, height: 10 }, vp)).toContain(
      'middle-center',
    );
  });

  it('reports area as a fraction of the viewport', () => {
    // 600x450 = 270000 of 1080000 = 25%
    expect(describeRegion({ x: 0, y: 0, width: 600, height: 450 }, vp)).toContain(
      '25% of viewport',
    );
  });

  const verdictFor = (name: string) =>
    structuralDiff({
      baseline: fixture.cases.noop.structure,
      current: fixture.cases[name].structure,
      imagesIdentical: false,
      pixels: fixture.cases[name].pixels,
      escalate: { command: 'jux handoff components-button--primary' },
    });

  it('leads with the tier-0 summary, deltas and flags, before the pixel figures', () => {
    const structural = verdictFor('text'); // text-only, flag text-changed
    const out = buildHandoffPrompt({ ...base, structural });
    expect(out.indexOf(structural.summary)).toBeLessThan(out.indexOf('mismatchPercent'));
    expect(out).toContain('  button[name="Save"]\n    text "Save" → "Save changes"');
    expect(out).toContain('Flags: text-changed');
    expect(out.indexOf('Flags:')).toBeLessThan(out.indexOf('## If still unsure'));
  });

  it('tells the agent to compare the deltas with what it intended, and when to look at pixels', () => {
    const out = buildHandoffPrompt({ ...base, structural: verdictFor('color') });
    expect(out).toContain('Check these deltas against the change you intended');
    expect(out).not.toContain('Part of the pixel change');
    const canvas = verdictFor('canvas'); // unknown, unexplained-pixels
    expect(canvas.explained).toBe('none');
    const partial = buildHandoffPrompt({ ...base, structural: canvas });
    expect(partial).toContain('Part of the pixel change has no matching');
  });

  it('without a verdict the prompt is unchanged in shape', () => {
    const out = buildHandoffPrompt(base);
    expect(out).not.toContain('## What changed (structure)');
    expect(out).toContain('## What changed');
  });

  it('a verdict with no baseline snapshot says so in one line, with no empty section', () => {
    const structural = structuralDiff({
      baseline: undefined,
      current: fixture.cases.color.structure,
      imagesIdentical: false,
      pixels: fixture.cases.color.pixels,
      escalate: { command: 'jux handoff x' },
    });
    expect(structural.flags).toContain('no-baseline-structure');
    const out = buildHandoffPrompt({ ...base, structural });
    expect(out).toContain('No structure snapshot for the baseline (approved before');
    expect(out).not.toContain('## What changed (structure)');
    expect(out).not.toContain('Part of the pixel change');
    expect(out).toContain('## What changed');
  });

  it('with deltas, advises approving by the real command', () => {
    const out = buildHandoffPrompt({ ...base, structural: verdictFor('color') });
    expect(out).toContain('`jux approve --story components-button--primary`');
  });
});
