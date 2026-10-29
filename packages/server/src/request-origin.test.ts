import { expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { localReviewOrigin } from './request-origin.js';
it('rejects LAN callers that forge localhost Host headers', () => {
  expect(
    localReviewOrigin({
      headers: { host: 'localhost:6006' },
      socket: { remoteAddress: '192.0.2.10' },
    } as IncomingMessage),
  ).toBeNull();
});
it('accepts the bound loopback origins only', () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    expect(
      localReviewOrigin({
        headers: { host: 'localhost:6006' },
        socket: { remoteAddress },
      } as IncomingMessage),
    ).toBe('http://localhost:6006');
  for (const host of [
    'attacker.invalid',
    'localhost.attacker.invalid',
    'localhost:6006/evil',
  ])
    expect(
      localReviewOrigin({
        headers: { host },
        socket: { remoteAddress: '127.0.0.1' },
      } as IncomingMessage),
    ).toBeNull();
});
