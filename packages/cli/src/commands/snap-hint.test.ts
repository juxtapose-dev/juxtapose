import { expect, it } from 'vitest';
import { noBrowserMessage } from '@juxtapose/core';
import { captureHint, describeLaunchFailure } from './snap.js';

it('the install step prints exactly once for a missing browser', () => {
  const message = noBrowserMessage();
  const line = `jux snap: could not launch the browser: ${message}${captureHint(message)}`;
  expect(line.match(/jux browser install/g)).toHaveLength(1);
});

it('still adds the install hint for a message that does not name it', () => {
  expect(captureHint('jux: --chrome /x does not exist.')).toMatch(
    /npx -p @juxtapose\/cli jux browser install/,
  );
});

it('adds nothing when the message names the install step, even if it also says could not launch', () => {
  expect(
    captureHint(
      'could not launch the browser; run `npx -p @juxtapose/cli jux browser install`',
    ),
  ).toBe('');
});

it('wraps a core message without a doubled jux: prefix', () => {
  expect(describeLaunchFailure('jux: no browser. Run x')).toBe(
    'jux snap: could not launch the browser: no browser. Run x',
  );
});
