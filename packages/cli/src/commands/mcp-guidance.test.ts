import { expect, test } from 'vitest';
import { handleMessage, McpServer, TOOLS } from './mcp.js';

test('initialization stays small when a client repeats guidance on each tool', async () => {
  const server = new McpServer({ project: process.cwd(), chrome: '/not-a-browser' });
  try {
    const response = await handleMessage(
      server,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      'test',
    );
    expect(response && 'result' in response).toBe(true);
    const { instructions } = (response as { result: { instructions: string } }).result;
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(400);
    const repeated = TOOLS.map((tool) => ({
      ...tool,
      description: `${instructions}\n\n${tool.description}`,
    }));
    // A real client discovery response repeated global guidance on every tool.
    // A server-only instruction budget misses that multiplication.
    expect(Buffer.byteLength(JSON.stringify(repeated))).toBeLessThanOrEqual(19_000);
    expect(TOOLS.find((t) => t.name === 'report')!.description).toContain(
      'not unique CSS selectors',
    );
    expect(TOOLS.find((t) => t.name === 'report')!.description).toContain(
      'do not identify CSS causes',
    );
    expect(TOOLS.find((t) => t.name === 'report')!.description).toContain(
      'captured document order',
    );
    expect(instructions).toContain('all required states, targets and behavior checks');
    expect(instructions).toContain('Never approve unless the user asks');
    expect(instructions).toContain('resolve only missing facts');
    expect(instructions).toContain('Prefer saved measurements');
  } finally {
    await server.close();
  }
});

test('workflow guidance remains with the tool that performs it', () => {
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
  expect(tool('snap').description).toContain('snap before editing');
  expect(tool('snap').description).toContain('then diff');
  expect(tool('run').description).toContain('variants together');
  expect(tool('run').description).toContain('do not repeat them');
  expect(tool('run').description).toContain('not design-target error');
  expect(tool('run').description).toContain('does not verify omitted targets');
  expect(JSON.stringify(tool('run').inputSchema)).toContain(
    'restore its source, not the baselines',
  );
  expect(tool('reference').description).toContain('without recapture');
  expect(tool('reference').description).toContain('CSS edits as hypotheses');
  expect(tool('reference').description).toContain('run affected states to verify');
  expect(tool('reference').description).toContain(
    'cannot add PNG target DOM, prove CSS causes or resolve abstained matches',
  );
  expect(tool('reference').description).toContain('observable the tool can supply');
  expect(tool('reference').description).toContain('omissions can remain');
  expect(tool('reference').description).toContain('detail=layout with name');
  expect(tool('reference').description).toContain('one paired PNG crop');
  expect(tool('reference').description).toContain('Use returned cropRequest directly');
  expect(tool('run').description).toContain('configured URL viewports have separate IDs');
  expect(tool('run').description).toContain('all=true');
  expect(tool('report').description).toContain('saved current-element rect/styles');
  expect(tool('approve').description).toContain('Only when the user asks');
});
