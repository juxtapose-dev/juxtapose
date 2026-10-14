import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { commitList, gitAddCommand } from './printed-commands.js';

const hostile = 'x\'; $(touch pwned) `id` "q" y';
const storage = { kind: 'git', dir: hostile } as const;

// Run the printed line with `git add --` swapped for printf, so the shell's
// word splitting is what is tested, not git.
const words = (line: string): string[] =>
  execFileSync('sh', ['-c', `printf '%s\\n' ${line}`], { cwd: '/tmp' })
    .toString()
    .split('\n')
    .slice(0, -1);

test('init prints git add with -- and every path as one literal word', () => {
  const line = gitAddCommand('juxtapose.config.json', storage);
  expect(line.startsWith('git add -- ')).toBe(true);
  expect(words(line.replace(/^git add -- /, ''))).toEqual([
    'juxtapose.config.json',
    'juxtapose.manifest.json',
    hostile,
    '.gitignore',
  ]);
});

test('approve prints the same paths, quoted', () => {
  expect(words(commitList(storage).replaceAll(' and ', ' '))).toEqual([
    'juxtapose.manifest.json',
    hostile,
  ]);
});
