import { describe, expect, it } from 'vitest';
import { checkNetwork, isExternal } from './network-policy.js';
import { resolveNetwork } from './network-rules.js';

describe('network.external', () => {
  it('layers call > story > project, default allow', () => {
    const block = { external: 'block' as const };
    const allow = { external: 'allow' as const };
    expect(resolveNetwork(undefined, undefined, undefined).default).toBe('allow');
    expect(resolveNetwork(block, undefined, undefined).default).toBe('block');
    expect(resolveNetwork(block, allow, undefined).default).toBe('allow');
    expect(resolveNetwork(allow, allow, block).default).toBe('block');
  });
  it('rejects bad values naming the place', () => {
    expect(() => checkNetwork({ external: 'replay' }, 'project config')).toThrow(
      /project config: network.external must be 'allow' or 'block'/,
    );
    expect(() => checkNetwork({ nope: 1 }, 'x')).toThrow(/unknown network option/);
    const say = (v: unknown) => {
      try {
        checkNetwork(v, 'project config');
      } catch (e) {
        return (e as Error).message;
      }
      return 'ok';
    };
    expect(say({ external: { default: 'placeholder' } })).toBe(
      "jux: project config: network.external.default must be 'allow' or 'block' ('placeholder' is for images, frames and media), got \"placeholder\"",
    );
    expect(say({ external: 'placeholder' })).toMatch(
      /network.external must be 'allow' or 'block'/,
    );
    expect(say({ external: { images: 'maybe' } })).toBe(
      "jux: project config: network.external.images must be 'allow', 'block' or 'placeholder', got \"maybe\"",
    );
    expect(say({ external: { image: 'block' } })).toBe(
      "jux: project config: unknown network.external option 'image' (expected default, images, frames, media)",
    );
    expect(say({ rules: 'x' })).toMatch(/network.rules must be an array/);
    expect(say({ rules: [{ match: '**', action: 'nope' }] })).toBe(
      "jux: project config: network.rules[0]: action must be 'allow', 'block' or 'placeholder', got \"nope\"",
    );
    expect(say({ rules: [{ match: 'type:Bogus', action: 'block' }] })).toMatch(
      /network.rules\[0\]: match: .*unknown resource type 'Bogus'/,
    );
    expect(say({ rules: [{ match: '**', action: 'block', extra: 1 }] })).toBe(
      "jux: project config: network.rules[0]: unknown option 'extra' (expected match, action)",
    );
    expect(say({ rules: [{ action: 'block' }] })).toMatch(/network.rules\[0\]: match/);
    expect(say({ rules: [{ match: 'type:Script', action: 'placeholder' }] })).toBe(
      "jux: project config: network.rules[0]: 'placeholder' only applies to Image, Document requests, but 'type:Script' matches Script only. Use 'block'.",
    );
    // detectable only by type: a URL rule is accepted and falls back to block at runtime
    expect(say({ rules: [{ match: 'https://x/**', action: 'placeholder' }] })).toBe('ok');
    expect(say({ rules: [{ match: 'type:Image', action: 'placeholder' }] })).toBe('ok');
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
