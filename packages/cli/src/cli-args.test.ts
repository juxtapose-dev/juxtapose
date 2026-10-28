// Argument validation over the built CLI (#130): a flag or positional a
// command does not take is a usage error, not something silently dropped.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CLI = path.resolve(import.meta.dirname, '../dist/index.js');
const empty = mkdtempSync(path.join(tmpdir(), 'jux-args-'));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

function jux(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: empty,
    encoding: 'utf8',
    env: { ...process.env, JUX_NO_DAEMON: '1' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('jux argument validation', () => {
  it('accepts positional selectors and combines them with --story', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jux-selector-'));
    try {
      writeFileSync(
        path.join(root, 'juxtapose.config.json'),
        JSON.stringify({
          platform: 'urls',
          urls: [
            { id: 'charts-a', url: 'http://127.0.0.1:1/' },
            { id: 'table-a', url: 'http://127.0.0.1:1/' },
          ],
        }),
      );
      for (const command of ['list', 'run']) {
        const r = jux(
          command,
          'charts-*',
          '--story',
          'table-a',
          '--project',
          root,
          '--json',
          ...(command === 'run' ? ['--dry-run'] : []),
        );
        expect(r.code, r.err).toBe(0);
        expect(JSON.parse(r.out)).toMatchObject({
          count: 2,
          captures: [{ storyId: 'charts-a' }, { storyId: 'table-a' }],
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['init', 'approve', 'check', 'mcp'])('rejects a positional on %s', (cmd) => {
    const r = jux(cmd, 'extra');
    expect(r.code).toBe(2);
    expect(r.err).toContain(`jux ${cmd}: unexpected argument 'extra'`);
  });

  it('rejects a second positional on handoff and a third on diff', () => {
    expect(jux('handoff', 'a', 'b').err).toContain("unexpected argument 'b'");
    expect(jux('diff', 'a', 'b', 'c').err).toContain("unexpected argument 'c'");
  });

  it.each(['init', 'run', 'approve', 'check', 'handoff', 'snap', 'diff', 'mcp'])(
    'rejects an unknown flag on %s',
    (cmd) => {
      const r = jux(cmd, '--bogus');
      expect(r.code).toBe(2);
      expect(r.err).toBe(
        `jux ${cmd}: unknown option --bogus. Try \`jux ${cmd} --help\`.\n`,
      );
    },
  );

  it('rejects a flag the command does not take, even if another does', () => {
    expect(jux('snap', '--story', 'x').err).toContain('unknown option --story');
    expect(jux('diff', 'a', 'b', '--all').err).toContain('unknown option --all');
  });

  it('rejects a value flag with no value', () => {
    expect(jux('run', '--story').err).toContain('--story needs a value');
    expect(jux('run', '--since').err).toContain('--since needs a value');
  });

  it.each([
    'init',
    'run',
    'approve',
    'check',
    'handoff',
    'snap',
    'diff',
    'mcp',
    'browser',
  ])('%s --help and -h print its usage and exit 0', (cmd) => {
    for (const flag of ['--help', '-h']) {
      const r = jux(cmd, flag);
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(r.out).toContain(`jux ${cmd}`);
    }
  });

  it('snap --help lists --viewport, --device and --orientation', () => {
    const out = jux('snap', '--help').out;
    expect(out).toContain('--viewport WxH');
    expect(out).toContain('--device <name>');
    expect(out).toContain('--orientation portrait|landscape');
  });

  it('per-command help is that command, not the whole manual', () => {
    const run = jux('run', '--help').out;
    expect(run).toContain('--settle-timeout');
    expect(run).not.toContain('jux approve [options]');
    expect(jux('check', '--help').out).not.toContain('--settle-timeout');
  });

  it('reports a missing workbench as itself, with the usage exit code', () => {
    const r = jux('run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('could not detect a workbench');
    expect(r.err).not.toContain('unexpected failure');
  });

  it('still accepts documented flags', () => {
    const r = jux('run', '--all', '--json', '--story', 'a', '--settle-timeout', '100');
    expect(r.err).not.toContain('unknown option');
    expect(r.err).not.toContain('unexpected argument');
  });
});

describe('reference crop context arguments', () => {
  it('rejects missing region and invalid padding values', () => {
    for (const args of [
      ['--padding', '96', '--json'],
      ['--region', 'id', '--padding', '-1', '--json'],
      ['--region', 'id', '--padding', '1.5', '--json'],
      ['--region', 'id', '--padding=', '--json'],
    ]) {
      const result = jux('reference', 'mobile', ...args);
      expect(result.code).toBe(2);
      expect(result.err).toContain('--padding');
    }
  });
  it('accepts a numeric crop context and reports missing project evidence rather than an argument error', () => {
    const result = jux(
      'reference',
      'mobile',
      '--region',
      'id',
      '--padding',
      '96',
      '--json',
    );
    expect(result.code).toBe(3);
    expect(result.err).toContain("unknown design reference 'mobile'");
    expect(jux('reference', '--help').out).toContain('--padding');
  });
});
