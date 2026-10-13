import { expect, it } from 'vitest';
import { noBrowserMessage } from '@juxtapose/core';
import { captureHint } from './snap.js';

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
