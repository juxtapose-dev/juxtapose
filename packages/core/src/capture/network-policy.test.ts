import { describe, expect, it } from 'vitest';
import { checkNetwork, isExternal, resolveExternal } from './network-policy.js';

describe('network.external', () => {
  it('layers call > story > project, default allow', () => {
    const block = { network: { external: 'block' as const } };
    const allow = { network: { external: 'allow' as const } };
    expect(resolveExternal(undefined, undefined, undefined)).toBe('allow');
    expect(resolveExternal(block, undefined, undefined)).toBe('block');
    expect(resolveExternal(block, allow, undefined)).toBe('allow');
    expect(resolveExternal(allow, allow, block)).toBe('block');
  });
  it('rejects bad values naming the place', () => {
    expect(() => checkNetwork({ external: 'replay' }, 'project config')).toThrow(
      /project config: network.external must be 'allow' or 'block'/,
    );
    expect(() => checkNetwork({ nope: 1 }, 'x')).toThrow(/unknown network option/);
    expect(checkNetwork(undefined, 'x')).toBeUndefined();
  });
  it('only http(s) requests to another origin are external', () => {
    const o = 'http://127.0.0.1:6006';
    expect(isExternal('http://127.0.0.1:6006/a.png', o)).toBe(false);
    expect(isExternal('http://localhost:6006/a.png', o)).toBe(true);
    expect(isExternal('https://picsum.photos/200', o)).toBe(true);
    expect(isExternal('data:image/png;base64,AA', o)).toBe(false);
    expect(isExternal('blob:http://127.0.0.1:6006/x', o)).toBe(false);
  });
});
