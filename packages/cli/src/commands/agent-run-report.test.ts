import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunReport } from '@juxtapose/core';
import { McpServer } from './mcp.js';
import {
  agentRunSummary,
  observedChanges,
  SavedReportCache,
} from './agent-run-report.js';

const projects: string[] = [];
afterEach(async () => {
  for (const project of projects.splice(0))
    await rm(project, { recursive: true, force: true });
});

function report(stories = 20): RunReport {
  return {
    runId: 'run_1',
    branch: 'test',
    commitSha: 'abc',
    capturedCount: stories,
    totalCount: stories,
    durationMs: 123,
    startedAt: '2026-01-01T00:00:00Z',
    summary: { pass: 0, fail: stories, new: 0, stale: 0, skip: 0 },
    results: Array.from({ length: stories }, (_, i) => ({
      storyId: `story-${i}`,
      status: 'fail' as const,
      mismatchPixels: i,
      mismatchPercent: i / 100,
      changedRegions: [],
      durationMs: 1,
      ...(i === 15 ? { unstable: { hashes: ['a', 'b'] } } : {}),
      ...(i === 19 ? { error: 'capture failed' } : {}),
    })),
  };
}

async function projectWithReport(value: RunReport): Promise<string> {
  const project = await mkdtemp(path.join(tmpdir(), 'jux-mcp-report-'));
  projects.push(project);
  const dir = path.join(project, '.juxtapose', 'runs', value.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(value));
  return project;
}

function json(result: Awaited<ReturnType<McpServer['call']>>) {
  expect(result.isError).toBe(false);
  return JSON.parse(
    result.content[0]!.type === 'text' ? result.content[0]!.text : '{}',
  ) as Record<string, unknown>;
}

describe('saved MCP run reports', () => {
  test('summary stays bounded and prioritizes capture errors and flakes', () => {
    const value = report(1000);
    value.results[16]!.unstable = { hashes: ['a'], unconfirmed: 'not rechecked' };
    value.results[16]!.unrechecked = true;
    value.groups = [
      {
        signature: 'shared',
        summary: 'Shared token changed',
        storyIds: value.results.map((r) => r.storyId),
      },
    ];
    const summary = agentRunSummary(value);
    expect(summary.attention).toHaveLength(8);
    expect(summary.attention.map((r) => r.storyId).slice(0, 2)).toEqual([
      'story-19',
      'story-15',
    ]);
    const unrechecked = report(1);
    unrechecked.results[0]!.unstable = { hashes: ['a'], unconfirmed: 'not rechecked' };
    unrechecked.results[0]!.unrechecked = true;
    expect(agentRunSummary(unrechecked).attention[0]?.stability).toBe('unrechecked');
    expect(summary.omittedAttention).toBe(992);
    expect(summary.groups).toEqual([{ summary: 'Shared token changed', count: 1000 }]);
    expect(JSON.stringify(summary).length).toBeLessThan(1600);
  });

  describe('observed changes across variants', () => {
    type Structural = NonNullable<RunReport['results'][number]['structural']>;
    const style = (el: string, prop: string, from: string, to: string) =>
      ({ kind: 'style', el, prop, from, to }) as const;
    const resized = (el: string, dw: number, dh: number) =>
      ({ kind: 'resized', el, dw, dh }) as const;
    const withDeltas = (id: string, deltas: Structural['deltas']) => ({
      storyId: id,
      status: 'fail' as const,
      mismatchPixels: 1,
      mismatchPercent: 1,
      changedRegions: [],
      durationMs: 1,
      structural: { deltas, deltaCount: deltas.length } as Structural,
    });
    const gap = style('main>section>form', 'gap', '20px', '12px');
    const green = style(
      'button[name="Save details"]',
      'background-color',
      'rgb(40, 91, 196)',
      'rgb(27, 119, 63)',
    );

    test('lists each distinct fact once, including one only a mobile variant shows', () => {
      const lines = observedChanges([
        withDeltas('card', [resized('main', 0, -24), gap, resized('div.field', 0, -8)]),
        withDeltas('card__mobile', [
          resized('main', 0, -24),
          gap,
          style('div.address-grid', 'grid-template-columns', '266px', '125px 125px'),
          resized('div.field (1st)', 0, -8),
          resized('fieldset', 0, -104),
        ]),
        withDeltas('other', [gap, green, resized('div.field (2nd)', 0, -8)]),
      ] as RunReport['results']);
      expect(lines).toEqual([
        'main>section>form gap 20px→12px (all 3)',
        'button[name="Save details"] background-color #285bc4→#1b773f (other)',
        'div.address-grid grid-template-columns 266px→125px 125px (card__mobile)',
        'div.field resized h-8px (all 3)',
      ]);
    });

    test('stays bounded and drops single-capture noise in a large run', () => {
      const results = Array.from({ length: 300 }, (_, i) =>
        withDeltas(`story-${i}`, [
          gap,
          style(`div.unique-${i}`, 'width', `${i}px`, `${i + 1}px`),
          resized(`section.s${i % 40}`, 0, 4),
        ]),
      ) as RunReport['results'];
      const lines = observedChanges(results);
      expect(lines[0]).toBe('main>section>form gap 20px→12px (all 300)');
      expect(lines.some((line) => line.includes('unique-'))).toBe(false);
      expect(lines.length).toBeLessThanOrEqual(7);
      expect(JSON.stringify(lines).length).toBeLessThan(900);
    });

    test('replaces the truncated group lines only when facts exist', () => {
      const value = report(2);
      value.groups = [{ signature: 's', summary: 'grouped', storyIds: ['story-0'] }];
      expect(agentRunSummary(value).groups).toBeDefined();
      value.results[0] = withDeltas('story-0', [gap]) as RunReport['results'][number];
      const summary = agentRunSummary(value);
      expect(summary.changesFromApproved).toEqual([
        'main>section>form gap 20px→12px (all 1)',
      ]);
      expect(summary.groups).toBeUndefined();
    });
  });

  test('explains exact-match stale baselines without asking for another visual lookup', () => {
    const stale = report(2);
    stale.summary = { pass: 0, fail: 0, new: 0, stale: 2, skip: 0 };
    stale.results.forEach((result) => {
      result.status = 'stale';
      result.mismatchPixels = 0;
      result.mismatchPercent = 0;
    });
    const compact = agentRunSummary(stale);
    expect(compact.next).toContain(
      'approval commits are outside current branch ancestry',
    );
    expect(compact.next).toContain('no visual edit, detailed report, or recapture');

    stale.results[1]!.status = 'fail';
    stale.summary = { pass: 0, fail: 1, new: 0, stale: 1, skip: 0 };
    const mixed = agentRunSummary(stale);
    expect(mixed.staleMeaning).toContain(
      'approval commit is outside current branch ancestry',
    );
    expect(mixed.next).toContain('Call report with story');

    stale.results[1]!.status = 'stale';
    stale.results[1]!.unstable = { hashes: ['a'], unconfirmed: 'not rechecked' };
    stale.results[1]!.unrechecked = true;
    expect(agentRunSummary(stale).next).toContain('Call report with story');
  });

  test('reads one saved story or full report without browser and refreshes changed reports', async () => {
    const initial = report(20);
    initial.results[12]!.controlGeometry = {
      observations: [
        {
          id: 'name',
          tag: 'input',
          role: 'textbox',
          suppressedResize: true,
          height: { approved: 49, current: 36 },
          provenance: 'structure',
          confidenceRule:
            'unique same DOM id or test ID, with matching tag and role in both snapshots; measured border-box size, not a CSS cause',
        },
      ],
      omitted: 0,
      abstained: 0,
      incompatible: false,
    };
    const project = await projectWithReport(initial);
    const cache = new SavedReportCache();
    const firstSummary = await cache.summary(project);
    expect(await cache.summary(project)).toBe(firstSummary);
    const server = new McpServer({ project });
    const experimental = new McpServer({ project }, { controlMeasurements: true });
    try {
      expect(json(await server.call('report', {})).schema).toBe('juxtapose.agent-run/v1');
      expect(json(await server.call('report', {}))).not.toHaveProperty(
        'controlMeasurements',
      );
      const expanded = json(await experimental.call('report', {}));
      expect(expanded.controlMeasurements).toEqual(
        agentRunSummary(initial, { controlMeasurements: true }).controlMeasurements,
      );
      expect(expanded).toHaveProperty('controlMeasurements.items.0.approved', 49);
      expect(json(await experimental.call('report', {}))).toEqual(expanded);
      expect(JSON.stringify(json(await server.call('report', {})))).not.toContain(
        'controlGeometry',
      );
      expect(
        json(await server.call('report', { story: 'story-12' })).controlGeometry,
      ).toEqual(initial.results[12]!.controlGeometry);
      expect(json(await server.call('report', { story: 'story-12' })).storyId).toBe(
        'story-12',
      );
      expect(
        (json(await server.call('report', { detail: 'full' })).results as unknown[])
          .length,
      ).toBe(20);
      const updated = report(21);
      await writeFile(
        path.join(project, '.juxtapose', 'runs', 'run_1', 'report.json'),
        JSON.stringify(updated),
      );
      expect(await cache.summary(project)).not.toBe(firstSummary);
      expect(json(await server.call('report', {})).capturedCount).toBe(21);
      expect((await server.call('report', { story: 'absent' })).isError).toBe(true);
    } finally {
      await server.close();
      await experimental.close();
    }
  });

  test('refuses traversal and a symlinked run outside the project', async () => {
    const project = await projectWithReport(report());
    const outside = await mkdtemp(path.join(tmpdir(), 'jux-report-outside-'));
    projects.push(outside);
    await writeFile(path.join(outside, 'report.json'), JSON.stringify(report()));
    await symlink(outside, path.join(project, '.juxtapose', 'runs', 'outside'));
    const server = new McpServer({ project });
    try {
      expect((await server.call('report', { runId: '../outside' })).isError).toBe(true);
      expect((await server.call('report', { runId: 'outside' })).isError).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('asks for a run when no saved run exists', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'jux-mcp-empty-'));
    projects.push(project);
    const server = new McpServer({ project });
    try {
      const result = await server.call('report', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Call the run tool first'),
      });
    } finally {
      await server.close();
    }
  });
});
