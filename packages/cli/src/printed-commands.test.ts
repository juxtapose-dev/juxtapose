import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { commitList, gitAddCommand, literalPathspec } from './printed-commands.js';

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
  expect(line.startsWith('GIT_LITERAL_PATHSPECS=0 git add -- ')).toBe(true);
  expect(words(line.replace(/^GIT_LITERAL_PATHSPECS=0 git add -- /, ''))).toEqual([
    ':(literal)juxtapose.config.json',
    ':(literal)juxtapose.manifest.json',
    `:(literal)${hostile}`,
    ':(literal).gitignore',
  ]);
});

test('approve prints the same paths, quoted', () => {
  expect(words(commitList(storage).replaceAll(' and ', ' '))).toEqual([
    'juxtapose.manifest.json',
    hostile,
  ]);
});

// git expands `* ? [` in a pathspec, so a git/fs dir named by the repo's config
// must be read as a name or `git add -- *` stages the whole tree.
test.each([
  ['*', ['a', 'b', 'q']],
  ['[ab]', ['a', 'b']],
  ['?', ['a', 'b', 'q']],
])(
  'a git dir of %j stages only that directory, never what the glob would match',
  async (dir, bystanders) => {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-literal-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const put = async (rel: string) => {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), 'x');
    };
    for (const f of [
      'juxtapose.config.json',
      'juxtapose.manifest.json',
      '.gitignore',
      'other.txt',
      `${dir}/z.webp`,
    ]) {
      await put(f);
    }
    for (const b of bystanders) await put(`${b}/secret.txt`);

    execFileSync(
      'sh',
      ['-c', gitAddCommand('juxtapose.config.json', { kind: 'git', dir })],
      {
        cwd: root,
        stdio: 'ignore',
        // Exported by a user's shell: the printed command must still work.
        env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
      },
    );
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(staged).toEqual(
      [
        '.gitignore',
        'juxtapose.config.json',
        'juxtapose.manifest.json',
        `${dir}/z.webp`,
      ].sort(),
    );
  },
);

test('literalPathspec quotes the magic prefix too', () => {
  expect(words(literalPathspec("it's"))).toEqual([":(literal)it's"]);
});
