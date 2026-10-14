import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { checkNetwork } from '../capture/network-policy.js';
import { ProjectConfigSchema } from '../config/schema.js';
import '../config/validate.js'; // registers the custom formats Value.Check needs
import type { Flake } from '../types.js';
import { describeFlakeGroup } from './describe.js';
import { decide, resolveNetwork } from '../capture/network-rules.js';
import { networkCoverage } from './coverage.js';
import { groupFlakes } from './group.js';

const image = (host: string): Flake => ({
  cause: 'external-image',
  confidence: 'high',
  evidence: { selector: 'img', host, url: `https://${host}/200` },
  fix: { stories: {} },
});
const frame = (host: string): Flake => ({ ...image(host), cause: 'embed' });
const order: Flake = {
  cause: 'order-dependence',
  confidence: 'medium',
  evidence: { reusedIn: ['second'] },
  fix: { freshRenderer: true },
};
const entries = (ids: string[], flake: Flake) =>
  ids.map((storyId) => ({ storyId, flake }));

describe('groupFlakes', () => {
  it('three stories with one cause and host are a group; two are not', () => {
    expect(groupFlakes(entries(['a', 'b'], image('picsum.photos')))).toEqual([]);
    const [g] = groupFlakes(entries(['c', 'a', 'b'], image('picsum.photos')));
    expect(g).toEqual({
      cause: 'external-image',
      host: 'picsum.photos',
      storyIds: ['a', 'b', 'c'],
      fix: {
        network: {
          rules: [
            { match: 'type:Image https://picsum.photos/**', action: 'placeholder' },
          ],
        },
      },
    });
  });

  it('a different host or cause is a different group', () => {
    const groups = groupFlakes([
      ...entries(['a', 'b'], image('picsum.photos')),
      ...entries(['c'], image('cdn.example.com')),
      ...entries(['d', 'e', 'f'], frame('picsum.photos')),
    ]);
    // 2 + 1 images on two hosts: neither reaches 3. The frames do.
    expect(groups.map((g) => [g.cause, g.host, g.storyIds])).toEqual([
      ['embed', 'picsum.photos', ['d', 'e', 'f']],
    ]);
  });

  it('order dependence is one group for the project, whichever stories', () => {
    const [g] = groupFlakes(entries(['x', 'y', 'z'], order));
    expect(g).toMatchObject({ cause: 'order-dependence', fix: { freshRenderer: true } });
    expect(g!.host).toBeUndefined();
  });

  it('other causes are never grouped', () => {
    const clock: Flake = {
      cause: 'clock',
      confidence: 'high',
      evidence: { selector: '.t' },
      fix: { stories: {} },
    };
    expect(groupFlakes(entries(['a', 'b', 'c', 'd'], clock))).toEqual([]);
  });

  it('the biggest group leads', () => {
    const groups = groupFlakes([
      ...entries(['a', 'b', 'c'], image('a.example')),
      ...entries(['d', 'e', 'f', 'g'], image('b.example')),
    ]);
    expect(groups.map((g) => g.host)).toEqual(['b.example', 'a.example']);
  });

  it('every group fix is a patch the config accepts', () => {
    for (const g of groupFlakes([
      ...entries(['a', 'b', 'c'], image('picsum.photos')),
      ...entries(['d', 'e', 'f'], frame('www.youtube.com')),
      ...entries(['g', 'h', 'i'], order),
    ])) {
      expect(Value.Check(ProjectConfigSchema, g.fix)).toBe(true);
      // and the runtime check of a network block, which also vets placeholders
      if (g.fix.network) expect(() => checkNetwork(g.fix.network, 'test')).not.toThrow();
    }
  });
});

describe('describeFlakeGroup', () => {
  it('is one line: count, what, and the project patch', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const [g] = groupFlakes(entries(ids, image('picsum.photos')));
    expect(describeFlakeGroup(g!)).toBe(
      '12 stories: external images from picsum.photos; fix: network.rules += {"match":"type:Image https://picsum.photos/**","action":"placeholder"}',
    );
  });

  it('order dependence names the project setting', () => {
    const [g] = groupFlakes(entries(['a', 'b', 'c'], order));
    expect(describeFlakeGroup(g!)).toBe(
      '3 stories: captures ran in a renderer process an earlier story had used; fix: freshRenderer = true',
    );
  });
});

describe('a group rule is typed', () => {
  const rule = (flake: Flake) =>
    groupFlakes(entries(['a', 'b', 'c'], flake))[0]!.fix.network!.rules!;

  it("an image group placeholders only that host's images; its scripts and styles stay allowed", () => {
    const policy = resolveNetwork({ rules: rule(image('www.google.com')) });
    const ask = (resourceType: string, subframeDocument = false) =>
      decide(policy, {
        url: 'https://www.google.com/x',
        resourceType,
        external: true,
        subframeDocument,
      });
    expect(ask('Image')).toBe('placeholder-image');
    for (const type of ['Script', 'Stylesheet', 'XHR', 'Fetch', 'Font'])
      expect(ask(type)).toBe('allow');
    expect(ask('Document', true)).toBe('allow');
  });

  it("a frame group placeholders only that host's frame documents", () => {
    expect(rule(frame('www.google.com'))).toEqual([
      { match: 'type:Document https://www.google.com/**', action: 'placeholder' },
    ]);
    const policy = resolveNetwork({ rules: rule(frame('www.google.com')) });
    const ask = (resourceType: string, subframeDocument: boolean) =>
      decide(policy, {
        url: 'https://www.google.com/maps/embed',
        resourceType,
        external: true,
        subframeDocument,
      });
    expect(ask('Document', true)).toBe('placeholder-frame');
    expect(ask('Script', false)).toBe('allow');
  });

  it('a config that already carries the group rule counts as covering that host', () => {
    const [g] = groupFlakes(entries(['a', 'b', 'c'], image('picsum.photos')));
    const covered = networkCoverage({ rules: g!.fix.network!.rules });
    const ref = (origin: string) => ({ kind: 'image' as const, origin, path: '/200' });
    expect(covered.covers?.(ref('https://picsum.photos'))).toBe(true);
    expect(covered.covers?.(ref('https://other.example'))).toBe(false);
  });
});
