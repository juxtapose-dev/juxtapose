import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from 'vitest';
import { McpServer, resolveMcpTools, TOOLS } from './mcp.js';

const CLI = path.resolve(import.meta.dirname, '../../dist/index.js');

test('tool selection defaults to every tool and accepts only exact names', () => {
  expect(resolveMcpTools(undefined)).toEqual(TOOLS);
  expect(TOOLS).toHaveLength(10);
  expect(resolveMcpTools('reference, run,report,run').map((tool) => tool.name)).toEqual([
    'run',
    'report',
    'reference',
  ]);
  for (const invalid of [
    '',
    ' ',
    ',',
    'run,',
    ',run',
    'run,,report',
    true,
    null,
    ['run'],
  ])
    expect(() => resolveMcpTools(invalid)).toThrow('--tools');
  for (const invalid of ['Run', 'run*', 'nonexistent'])
    expect(() => resolveMcpTools(invalid)).toThrow('unknown tool');
});

test('direct calls reject hidden tools before their arguments or actions are processed', async () => {
  const server = new McpServer({ tools: 'report', chrome: '/not-a-browser' });
  try {
    await expect(
      server.call('snap', { url: 'http://127.0.0.1:1/', as: 'x' }),
    ).rejects.toThrow('disabled tool');
    await expect(server.call('approve', { stories: ['card'] })).rejects.toThrow(
      'disabled tool',
    );
    const report = await server.call('report', { detail: 'invalid' });
    expect(report.isError).toBe(true);
    expect(JSON.stringify(report)).toContain("'detail' must be");
  } finally {
    await server.close();
  }
});

test('real stdio CLI limits discovery and invocation with compact restricted instructions', () => {
  const requests = [
    { method: 'initialize', params: {} },
    { method: 'tools/list' },
    {
      method: 'tools/call',
      params: { name: 'snap', arguments: { url: 'http://127.0.0.1:1/', as: 'x' } },
    },
    {
      method: 'tools/call',
      params: { name: 'approve', arguments: { stories: ['card'] } },
    },
    {
      method: 'tools/call',
      params: { name: 'report', arguments: { detail: 'invalid' } },
    },
  ].map((request, index) => ({ jsonrpc: '2.0', id: index + 1, ...request }));
  const child = spawnSync(
    process.execPath,
    [CLI, 'mcp', '--tools', 'run,report,reference', '--chrome', '/not-a-browser'],
    {
      input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  const replies = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const byId = (id: number) => replies.find((reply) => reply.id === id);
  expect(replies).toHaveLength(requests.length);
  const { instructions } = byId(1).result as { instructions: string };
  const { tools } = byId(2).result as { tools: typeof TOOLS };
  expect(tools.map((tool) => tool.name)).toEqual(['run', 'report', 'reference']);
  expect(instructions).not.toMatch(/snap|diff|explain|check for/);
  expect(instructions).toContain('Never approve unless the user asks');
  expect(byId(3).error).toMatchObject({ code: -32602, message: 'unknown tool: snap' });
  expect(byId(4).error).toMatchObject({ code: -32602, message: 'unknown tool: approve' });
  expect(byId(5).result.isError).toBe(true);
  expect(JSON.stringify(byId(5).result)).toContain("'detail' must be");
  const repeated = {
    ...byId(2),
    result: {
      tools: tools.map((tool) => ({
        ...tool,
        description: `${instructions}\n\n${tool.description}`,
      })),
    },
  };
  // Includes target-only, ancestor, focused evidence and checkpoint schemas.
  expect(Buffer.byteLength(JSON.stringify(byId(2)))).toBeLessThanOrEqual(8_000);
  expect(Buffer.byteLength(JSON.stringify(repeated))).toBeLessThanOrEqual(8_700);
});

test.each(['', 'run,', 'not-a-tool'])(
  'CLI rejects invalid --tools %j before starting protocol',
  (value) => {
    const child = spawnSync(process.execPath, [CLI, 'mcp', '--tools', value], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.status).toBe(2);
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain('--tools');
  },
);

test('CLI rejects --tools without a value and documents the option', () => {
  const missing = spawnSync(process.execPath, [CLI, 'mcp', '--tools'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('--tools');
  const help = spawnSync(process.execPath, [CLI, 'mcp', '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('--tools <names>');
});
