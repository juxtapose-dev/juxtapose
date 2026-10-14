// packages/core/src/report/run-report.test.ts
import { expect, test } from 'vitest';
import { isRunReport, parseRunReport } from './run-report.js';

test('parses a report and names the file that is not one', () => {
  const report = { runId: 'r', results: [{ storyId: 'a--b', status: 'pass' }] };
  expect(parseRunReport(JSON.stringify(report)).results[0]?.storyId).toBe('a--b');
  for (const text of ['null', '[]', '{"results":{}}', '{"results":[{"storyId":1}]}'])
    expect(() => parseRunReport(text, 'x/report.json')).toThrow(
      /x\/report\.json is not a run report/,
    );
});

test('a report written before per-story hashes still parses', () => {
  const old = {
    runId: 'r',
    results: [{ storyId: 'a--b', status: 'pass', mismatchPixels: 0 }],
  };
  const parsed = parseRunReport(JSON.stringify(old));
  expect(isRunReport(old)).toBe(true);
  expect(parsed.results[0]?.hash).toBeUndefined();
  const withHash = { runId: 'r', results: [{ storyId: 'a', status: 'pass', hash: 'h' }] };
  expect(parseRunReport(JSON.stringify(withHash)).results[0]?.hash).toBe('h');
});
