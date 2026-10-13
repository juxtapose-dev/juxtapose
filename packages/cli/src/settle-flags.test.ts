import { describe, expect, it } from 'vitest';
import { settleFlagArgs, settleFromFlags } from './settle-flags.js';

describe('settle flags', () => {
  it('none set: no layer at all', () => {
    expect(settleFromFlags({ 'settle-ready': false }, 'jux run')).toEqual({});
  });

  it('all set: the config shape, and the retry repeats them', () => {
    const flags = {
      'settle-timeout': '3000',
      'settle-ready': true,
      'settle-ignore': ['/poll'],
      'settle-require': ['type:Fetch /api/feed'],
    };
    expect(settleFromFlags(flags, 'jux snap')).toEqual({
      settle: {
        timeout: 3000,
        ready: true,
        network: { ignore: ['/poll'], require: ['type:Fetch /api/feed'] },
      },
    });
    expect(settleFlagArgs(flags)).toEqual([
      '--settle-timeout',
      '3000',
      '--settle-ready',
      '--settle-ignore',
      '/poll',
      '--settle-require',
      "'type:Fetch /api/feed'",
    ]);
  });

  it('a bad value is a usage error naming the flag', () => {
    for (const t of ['0', '1.5', '60001', 'soon', '-1'])
      expect(settleFromFlags({ 'settle-timeout': t }, 'jux run')).toEqual({
        error: `jux run: --settle-timeout must be a whole number of ms from 1 to 60000, got '${t}'. Try --settle-timeout 3000.`,
      });
    expect(settleFromFlags({ 'settle-ignore': ['type:Nope'] }, 'jux snap')).toMatchObject(
      {
        error: expect.stringMatching(
          /^jux snap: --settle-ignore: pattern 'type:Nope': unknown/,
        ),
      },
    );
  });
});
