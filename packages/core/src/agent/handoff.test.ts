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
  it('a story in a flake group also gets the shared project fix', () => {
    const out = buildHandoffPrompt({
      ...base,
      status: 'new',
      unstable: { hashes: ['a', 'b'] },
      flakeGroup: {
        cause: 'external-image',
        host: 'picsum.photos',
        storyIds: ['a', 'b', 'c'],
        fix: {
          network: {
            rules: [
              { match: 'type:Image https://picsum.photos/**', action: 'placeholder' },
            ],
          },
        },
      },
    });
    expect(out).toContain(
      'Shared fix: 3 stories: external images from picsum.photos; fix: network.rules += {"match":"type:Image https://picsum.photos/**","action":"placeholder"}',
    );
  });

  it('an unstable story gets the flake line: the cause, the evidence and the exact fix', () => {
    const out = buildHandoffPrompt({
      ...base,
      status: 'new',
      unstable: { hashes: ['a', 'b'] },
      flake: {
        cause: 'external-image',
        confidence: 'high',
        evidence: { selector: '.card img', host: 'picsum.photos' },
        fix: {
          stories: {
            'card--basic': { network: { external: { images: 'placeholder' } } },
          },
        },
      },
    });
    expect(out).toContain(
      '**Unstable: external image from picsum.photos in .card img; fix: stories["card--basic"].network.external.images = "placeholder"**',
    );
    expect(
      buildHandoffPrompt({ ...base, unstable: { hashes: ['a', 'b'] } }),
    ).not.toContain('fix:');
  });

  it('a settle-timeout comes first, with what was pending and the knob for each case', () => {
    for (const status of ['fail', 'new'] as const) {
      const out = buildHandoffPrompt({
        ...base,
        status,
        settle: {
          status: 'timeout',
          timeoutMs: 1500,
          pending: ['1 request to /api/feed in flight (Fetch)'],
        },
      });
      expect(out).toContain('**settle-timeout:** the page still had work at the 1500 ms');
      expect(out).toContain('- 1 request to /api/feed in flight (Fetch)');
      expect(out).toContain('`settle.network.ignore`');
      expect(out.indexOf('settle-timeout')).toBeLessThan(
        out.indexOf(status === 'new' ? 'no baseline yet' : 'What changed'),
      );
    }
    expect(buildHandoffPrompt(base)).not.toContain('settle');
  });

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
    // Size alone never earns reassurance (#201): no structure, so unexplained.
    const tiny = buildHandoffPrompt({ ...base, mismatchPercent: 0.02 });
    expect(tiny).toContain('Unexplained: 0.02% of pixels changed');
    expect(tiny).toContain('do not approve without looking');
    expect(tiny).not.toMatch(/antialias|noise|safe to approve/i);

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

  it('leads with structured observations and coverage rather than the truncated UI summary', () => {
    const structural = verdictFor('text'); // text-only, flag text-changed
    const out = buildHandoffPrompt({ ...base, structural });
    expect(out).not.toContain(structural.summary);
    const evidence = JSON.parse(out.match(/```json\n([^\n]+)\n```/)![1]);
    expect(evidence.deltas).toEqual(structural.deltas);
    expect(evidence.recorded).toBe(structural.deltas.length);
    expect(evidence.total).toBe(structural.deltaCount);
    expect(out.indexOf('Observed DOM/style')).toBeLessThan(
      out.indexOf('mismatchPercent'),
    );
    expect(out).toContain('not causal proof');
    expect(out).toContain('Flags: text-changed');
    expect(out.indexOf('Flags:')).toBeLessThan(out.indexOf('## If still unsure'));
  });

  it('states stored-evidence limits without promising missing deltas in a sidecar', () => {
    const structural = verdictFor('text');
    structural.deltaCount = structural.deltas.length + 7;
    const out = buildHandoffPrompt({ ...base, structural });
    expect(out).toContain('Evidence incomplete: 7 additional deltas');
    expect(out).not.toContain('(+');
    expect(out).not.toContain('more (see the diff data file)');
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
    expect(out).toContain('No structure snapshot for the baseline, so nothing explains');
    expect(out).not.toContain('approved before');
    expect(out).not.toContain('## What changed (structure)');
    expect(out).not.toContain('Part of the pixel change');
    expect(out).toContain('## What changed');
  });

  // Review: a sub-threshold background change came with "Under 0.1% —
  // consistent with sub-pixel antialiasing noise. Usually safe to approve"
  // beside a real background-color delta.
  it('a tiny pixel count with structural deltas does not call it noise', () => {
    const structural = verdictFor('background');
    expect(structural.deltaCount).toBeGreaterThan(0);
    const out = buildHandoffPrompt({ ...base, mismatchPercent: 0, structural });
    const assessment = out.slice(
      out.indexOf('## Assessment'),
      out.indexOf('## What to do'),
    );
    expect(assessment).toContain(
      `Pixels are below tolerance, but structure records ${structural.deltaCount} delta(s); judge those, not the pixel count.`,
    );
    expect(out).not.toContain('antialiasing');
    expect(out).not.toContain('Usually safe to approve');
  });

  // #201: text-sm -> text-base, 0.05% mismatch in one 115x16 region, baseline
  // approved without structure. The handoff said "consistent with sub-pixel
  // antialiasing noise. Usually safe to approve".
  it('#201: a small text change with no baseline structure is unexplained, never noise', () => {
    const structural = structuralDiff({
      baseline: undefined,
      current: fixture.cases.text.structure,
      imagesIdentical: false,
      pixels: fixture.cases.text.pixels,
      escalate: { command: 'jux handoff x' },
    });
    expect(structural.flags).toContain('no-baseline-structure');
    const out = buildHandoffPrompt({
      ...base,
      mismatchPercent: 0.05,
      mismatchPixels: 512,
      changedRegions: [{ x: 412, y: 88, width: 115, height: 16 }],
      structural,
    });
    const assessment = out.slice(
      out.indexOf('## Assessment'),
      out.indexOf('## What to do'),
    );
    expect(assessment).toContain('Unexplained: 0.05% of pixels changed in 1 region');
    expect(assessment).toContain('(412, 88) 115×16px');
    expect(assessment).toContain('no baseline structure');
    expect(assessment).toContain('Inspect the crops and do not approve without looking');
    expect(out).not.toMatch(/antialias|noise|safe to approve/i);
  });

  it('thin hairline regions with identical structure present are likely rendering noise', () => {
    const noop = fixture.cases.noop.structure;
    const hairline = [{ x: 100, y: 50, width: 40, height: 2 }];
    const structural = structuralDiff({
      baseline: noop,
      current: noop,
      imagesIdentical: false,
      pixels: { mismatchPixels: 12, changedRegions: hairline, dimensionMismatch: false },
      escalate: { command: 'jux handoff x' },
    });
    expect(structural.classification).toBe('render-drift');
    expect(structural.deltaCount).toBe(0);
    const out = buildHandoffPrompt({
      ...base,
      mismatchPercent: 0.02,
      changedRegions: hairline,
      structural,
    });
    expect(out).toContain('Likely rendering noise');
    // Identical structure but a fat region is not the antialiasing shape.
    const fat = buildHandoffPrompt({
      ...base,
      mismatchPercent: 0.02,
      changedRegions: [{ x: 100, y: 50, width: 115, height: 16 }],
      structural,
    });
    expect(fat).not.toContain('Likely rendering noise');
    expect(fat).toContain('Unexplained');
  });

  it('a partial in-closure cause says other imports could not be traced, and does not blame the file', () => {
    const structural = {
      ...verdictFor('color'),
      cause: {
        kind: 'in-closure' as const,
        files: [{ path: 'stories/Button.stories.jsx', distance: 0 }],
        partial: true as const,
      },
    };
    const out = buildHandoffPrompt({
      ...base,
      componentPath: '/repo/stories/Button.stories.jsx',
      structural,
    });
    expect(out).toContain(
      'Changed files this story imports, nearest first: `stories/Button.stories.jsx` (the story file itself); other imports could not be traced.',
    );
    const todo = out.slice(out.indexOf('## What to do'));
    expect(todo).toContain('not necessarily the cause');
    // A full trace keeps the plain wording and steps.
    const full = buildHandoffPrompt({
      ...base,
      structural: {
        ...structural,
        cause: { kind: 'in-closure', files: structural.cause.files },
      },
    });
    expect(full).toContain('(the story file itself).');
    expect(full).not.toContain('could not be traced');
    expect(full).not.toContain('not necessarily the cause');
  });

  it('with deltas, advises approving by the real command', () => {
    const out = buildHandoffPrompt({ ...base, structural: verdictFor('color') });
    expect(out).toContain('`jux approve --story components-button--primary`');
  });
});

describe('handoff for a variant capture', () => {
  it('says which variant it is and what it sets', async () => {
    const { buildHandoffPrompt, handoffVariant } = await import('./handoff.js');
    const variant = handoffVariant({
      baseStoryId: 'card--default',
      variant: 'mobile-dark',
      variantParams: { viewport: { width: 375, height: 812 }, colorScheme: 'dark' },
    });
    const text = buildHandoffPrompt({
      storyId: 'card--default__mobile-dark',
      storyTitle: 'Card — Default',
      status: 'new',
      mismatchPercent: 0,
      mismatchPixels: 0,
      changedRegions: [],
      viewport: { width: 375, height: 812 },
      componentPath: '',
      images: {},
      projectRoot: '/p',
      ...(variant ? { variant } : {}),
    });
    expect(text).toContain(
      'This capture is the `mobile-dark` variant of `card--default`, captured with colorScheme dark, viewport 375×812.',
    );
    expect(handoffVariant({})).toBeUndefined();
  });
});

describe('baseline image unavailable', () => {
  const prompt = buildHandoffPrompt({
    ...base,
    mismatchPercent: 0,
    mismatchPixels: 0,
    changedRegions: [],
    baselineImage: 'unavailable',
    images: { current: 'c.webp' },
  });

  it('states why there is no pixel diff and what restores it', () => {
    expect(prompt).toContain(
      'baseline image not available (not in cache); structure diff only',
    );
    expect(prompt).toContain('image cache');
  });

  it('does not print pixel numbers it never measured', () => {
    expect(prompt).not.toContain('mismatchPercent');
    expect(prompt).not.toContain('## Assessment');
  });
});

describe('guidance by store kind', () => {
  it('tells cache users never to add an image, and git-store users nothing of the kind', () => {
    expect(buildHandoffPrompt(base)).toContain('Never `git add` an image');
    expect(buildHandoffPrompt({ ...base, imagesCommitted: true })).not.toContain(
      'Never `git add`',
    );
  });
});
