import { describe, expect, it } from 'vitest';
import { checkNetwork } from './network-policy.js';
import { checkProjectSettle } from './settle-options.js';
import { expandVariants } from './variants.js';
import { decide, isActive, mergeNetwork, resolveNetwork } from './network-rules.js';

const req = (
  url: string,
  resourceType: string,
  over: { external?: boolean; subframeDocument?: boolean } = {},
) => ({
  url,
  resourceType,
  external: over.external ?? true,
  subframeDocument: over.subframeDocument ?? resourceType === 'Document',
});

describe('mergeNetwork', () => {
  it('merges the type map field by field; the string form is { default }', () => {
    expect(
      mergeNetwork(
        { external: { default: 'block', images: 'placeholder' } },
        { external: 'allow' },
      ),
    ).toEqual({ external: { default: 'allow', images: 'placeholder' } });
    expect(
      mergeNetwork({ external: { frames: 'block' } }, { external: { media: 'block' } }),
    ).toEqual({ external: { frames: 'block', media: 'block' } });
  });
  it('puts the higher layer rules first', () => {
    const under = { rules: [{ match: 'a', action: 'block' as const }] };
    const over = { rules: [{ match: 'b', action: 'allow' as const }] };
    expect(mergeNetwork(under, over)?.rules?.map((r) => r.match)).toEqual(['b', 'a']);
  });
  it('leaves a string external as it was when only one side sets it', () => {
    expect(mergeNetwork(undefined, { external: 'block' })).toEqual({ external: 'block' });
    expect(mergeNetwork({ external: 'block' }, undefined)).toEqual({ external: 'block' });
  });
});

describe('decide', () => {
  const p = (n: Parameters<typeof checkNetwork>[0]) =>
    resolveNetwork(checkNetwork(n, 'test'));

  it('string form: default for third-party, nothing for first-party', () => {
    const block = p({ external: 'block' });
    expect(decide(block, req('http://o/x.png', 'Image'))).toBe('block');
    expect(decide(block, req('http://o/x.png', 'Image', { external: false }))).toBe(
      'allow',
    );
  });
  it('type entries override default for third-party requests only', () => {
    const pol = p({
      external: { default: 'block', images: 'placeholder', media: 'allow' },
    });
    expect(decide(pol, req('http://o/x.png', 'Image'))).toBe('placeholder-image');
    expect(decide(pol, req('http://o/x.png', 'Image', { external: false }))).toBe(
      'allow',
    );
    expect(decide(pol, req('http://o/v', 'Media'))).toBe('allow');
    expect(decide(pol, req('http://o/f', 'Document'))).toBe('block');
    expect(decide(pol, req('http://o/s.js', 'Script'))).toBe('block');
  });
  it('frames placeholder', () => {
    const pol = p({ external: { frames: 'placeholder' } });
    expect(decide(pol, req('http://o/f', 'Document'))).toBe('placeholder-frame');
  });
  it('media placeholder means block', () => {
    expect(
      decide(p({ external: { media: 'placeholder' } }), req('http://o/v', 'Media')),
    ).toBe('block');
  });
  it('rules go first, in order, first match wins, any origin', () => {
    const pol = p({
      external: 'block',
      rules: [
        { match: 'http://o/ok/**', action: 'allow' },
        { match: 'http://o/**', action: 'block' },
        { match: 'http://o/ok/late', action: 'allow' },
      ],
    });
    expect(decide(pol, req('http://o/ok/late', 'Image'))).toBe('allow');
    expect(decide(pol, req('http://o/other', 'Image'))).toBe('block');
    const own = p({ rules: [{ match: 'http://own/**', action: 'block' }] });
    expect(decide(own, req('http://own/a', 'Image', { external: false }))).toBe('block');
  });
  it('placeholder on a type with no stand-in falls back to block', () => {
    const pol = p({ rules: [{ match: 'http://o/**', action: 'placeholder' }] });
    expect(decide(pol, req('http://o/a.png', 'Image'))).toBe('placeholder-image');
    expect(decide(pol, req('http://o/a.js', 'Script'))).toBe('block');
    expect(decide(pol, req('http://o/a.mp4', 'Media'))).toBe('block');
    expect(decide(pol, req('http://o/f', 'Document'))).toBe('placeholder-frame');
  });
  it('a rule by type', () => {
    const pol = p({ rules: [{ match: 'type:Media', action: 'block' }] });
    expect(decide(pol, req('http://o/v', 'Media', { external: false }))).toBe('block');
    expect(decide(pol, req('http://o/i', 'Image', { external: false }))).toBe('allow');
  });
});

describe('isActive', () => {
  it('is false when nothing can change a request', () => {
    expect(isActive(resolveNetwork())).toBe(false);
    expect(isActive(resolveNetwork({ external: 'allow' }))).toBe(false);
    expect(isActive(resolveNetwork({ rules: [{ match: '**', action: 'allow' }] }))).toBe(
      false,
    );
    expect(isActive(resolveNetwork({ external: { images: 'placeholder' } }))).toBe(true);
    expect(isActive(resolveNetwork({ external: 'block' }))).toBe(true);
  });
});

describe('placeholder rules that cannot hit a placeholderable type', () => {
  const bad = {
    network: { rules: [{ match: 'type:Script', action: 'placeholder' as const }] },
  };
  it('are refused wherever a network value is declared', () => {
    expect(() => checkProjectSettle(bad)).toThrow(
      /project config: network.rules\[0\]: 'placeholder' only applies/,
    );
    expect(() => checkProjectSettle({ stories: { 'a--*': bad } })).toThrow(
      /project config: stories 'a--\*': network.rules\[0\]/,
    );
    expect(() => checkNetwork(bad.network, "story 'a--b'")).toThrow(
      /story 'a--b': network.rules\[0\]/,
    );
    expect(() => expandVariants([], { m: bad }, undefined)).toThrow(
      /variant 'm': network.rules\[0\]/,
    );
  });
});
