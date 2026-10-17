import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunReport } from '@juxtapose/core';
import { McpServer } from './mcp.js';
import { agentRunSummary, SavedReportCache } from './agent-run-report.js';

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
    const project = await projectWithReport(report(20));
    const cache = new SavedReportCache();
    const firstSummary = await cache.summary(project);
    expect(await cache.summary(project)).toBe(firstSummary);
    const server = new McpServer({ project });
    try {
      expect(json(await server.call('report', {})).schema).toBe('juxtapose.agent-run/v1');
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
