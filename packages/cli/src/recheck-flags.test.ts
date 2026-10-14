import { expect, test } from 'vitest';
import { checkArgs } from './cli-args.js';
import { recheckFromFlags } from './recheck-flags.js';

test('no flag leaves the mode to the config', () => {
  expect(recheckFromFlags({}, 'jux run')).toEqual({});
});

test('--recheck takes a mode, --no-recheck means off', () => {
  expect(recheckFromFlags({ recheck: 'new' }, 'jux run')).toEqual({ recheck: 'new' });
  expect(recheckFromFlags({ 'no-recheck': true }, 'jux run')).toEqual({ recheck: 'off' });
  expect(recheckFromFlags({ recheck: 'off', 'no-recheck': true }, 'jux run')).toEqual({
    recheck: 'off',
  });
});

test('a bad mode or a contradiction is a usage error naming the flag', () => {
  expect(recheckFromFlags({ recheck: 'sometimes' }, 'jux run')).toEqual({
    error:
      "jux run: --recheck must be changed, new, off, got 'sometimes'. Try --recheck new.",
  });
  const both = recheckFromFlags({ recheck: 'new', 'no-recheck': true }, 'jux run');
  expect('error' in both && both.error).toContain(
    '--no-recheck contradicts --recheck new',
  );
});

test('run and config take the flags; approve and snap do not', () => {
  expect(checkArgs('run', { recheck: 'off', 'no-recheck': true }, [])).toBeUndefined();
  expect(checkArgs('config', { explain: 'a', recheck: 'off' }, [])).toBeUndefined();
  expect(checkArgs('run', { recheck: true }, [])).toContain('--recheck needs a value');
  expect(checkArgs('approve', { recheck: 'off' }, [])).toContain('unknown option');
  expect(checkArgs('snap', { 'no-recheck': true }, [])).toContain('unknown option');
});
