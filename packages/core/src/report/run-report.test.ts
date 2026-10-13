// packages/core/src/report/run-report.test.ts
import { expect, test } from 'vitest';
import { parseRunReport } from './run-report.js';

test('parses a report and names the file that is not one', () => {
  const report = { runId: 'r', results: [{ storyId: 'a--b', status: 'pass' }] };
  expect(parseRunReport(JSON.stringify(report)).results[0]?.storyId).toBe('a--b');
  for (const text of ['null', '[]', '{"results":{}}', '{"results":[{"storyId":1}]}'])
    expect(() => parseRunReport(text, 'x/report.json')).toThrow(
      /x\/report\.json is not a run report/,
    );
});
