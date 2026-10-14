import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../config/schema.js';
import '../config/validate.js'; // registers the custom formats Value.Check needs
import { FLAKE_CAUSES, type Flake, type FlakeCause } from '../types.js';
import {
  classifyFlake,
  RENDER_DRIFT_MAX_PERCENT,
  type FlakeObservations,
} from './classify.js';
import { describeFlake, formatFix } from './describe.js';
import { looksLikeTime } from './time-text.js';

const base: FlakeObservations = {
  storyId: 'card--basic',
  settlePending: [],
  settleTimedOut: false,
  settleRequests: [],
  settleOmitted: 0,
  inCustomElement: false,
  flags: [],
  reused: [],
  mismatchPercent: 0.5,
  structureIdentical: false,
  externals: [],
  textChanges: [],
  oneSided: [],
  covered: { images: false, frames: false },
};
const obs = (o: Partial<FlakeObservations>): FlakeObservations => ({ ...base, ...o });

const image = {
  selector: '.card img',
  ref: { kind: 'image' as const, origin: 'https://picsum.photos', path: '/200' },
  overlap: 4000,
};
const frame = {
  selector: 'iframe.player',
  ref: { kind: 'frame' as const, origin: 'https://www.youtube.com', path: '/embed/x' },
  overlap: 9000,
};
const clock = { selector: '.clock', before: '10:41', after: '10:42' };
const quote = { selector: '.quote', before: 'Hello', after: 'World' };
const late = {
  selector: '.results',
  presentIn: 'second' as const,
  area: 1000,
  stable: true,
};
const pending = ['1 request to /api/feed in flight (Fetch)'];
const ORIGIN = 'http://127.0.0.1:6006';
/** A capture that hit the settle cap with these requests in flight. */
const stuck = (
  requests: Array<{ url: string; type: string }>,
  more: Partial<FlakeObservations> = {},
): Partial<FlakeObservations> => ({
  settleTimedOut: true,
  settleOrigin: ORIGIN,
  settleRequests: requests,
  settlePending: requests.map(
    (r) => `1 request to ${new URL(r.url).pathname} in flight (${r.type})`,
  ),
  flags: ['settle-timeout'],
  ...more,
});
const cdnImage = { url: 'https://cdn.example.com/id/78/200/300.jpg', type: 'Image' };

/** The config accepts the patch as written: it is what a person pastes in. */
function accepted(flake: Flake): boolean {
  return flake.fix === null || Value.Check(ProjectConfigSchema, flake.fix);
}

describe('each cause', () => {
  it('settle-timeout: a third-party image still loading gets a host-wide placeholder for images', () => {
    const f = classifyFlake(obs(stuck([cdnImage])));
    expect(f.cause).toBe('settle-timeout');
    expect(f.confidence).toBe('high');
    // The host and the type, never the path: a random-photo service
    // redirects to a new path every run.
    expect(f.fix).toEqual({
      stories: {
        'card--basic': {
          network: {
            rules: [
              { match: 'type:Image https://cdn.example.com/**', action: 'placeholder' },
            ],
          },
        },
      },
    });
  });

  it('settle-timeout: a frame document is placeholdered by type, one rule per host and type', () => {
    const f = classifyFlake(
      obs(
        stuck([
          { url: 'https://maps.example.com/embed?a=1', type: 'Document' },
          { url: 'https://maps.example.com/embed?a=2', type: 'Document' },
          { url: 'https://maps.example.com/tile.png', type: 'Image' },
        ]),
      ),
    );
    expect(f.fix?.stories?.['card--basic']?.network?.rules).toEqual([
      { match: 'type:Document https://maps.example.com/**', action: 'placeholder' },
      { match: 'type:Image https://maps.example.com/**', action: 'placeholder' },
    ]);
  });

  it("settle-timeout: never blocks a stylesheet, script, font, API call or the page's own request", () => {
    const f = classifyFlake(
      obs(
        stuck([
          { url: 'https://fonts.googleapis.com/css', type: 'Stylesheet' },
          { url: 'https://api.example.com/feed', type: 'Fetch' },
          { url: 'https://cdn.example.com/app.js', type: 'Script' },
          { url: `${ORIGIN}/api/feed`, type: 'Fetch' },
          { url: `${ORIGIN}/hero.jpg`, type: 'Image' },
        ]),
      ),
    );
    expect(f.cause).toBe('settle-timeout');
    expect(f.fix).toBeNull();
    expect(f.confidence).toBe('medium');
    expect(JSON.stringify(f)).not.toContain('block');
  });

  it('settle-timeout: data:, blob: and WebSocket requests are not rules', () => {
    const f = classifyFlake(
      obs(
        stuck([
          { url: 'data:image/png;base64,AAAA', type: 'Image' },
          { url: 'blob:http://x/1', type: 'Image' },
          { url: 'wss://live.example.com/socket', type: 'WebSocket' },
          cdnImage,
        ]),
      ),
    );
    expect(f.fix?.stories?.['card--basic']?.network?.rules).toHaveLength(1);
  });

  it('settle-timeout: partial evidence is low confidence (a truncated URL, "14 more requests")', () => {
    const f = classifyFlake(
      obs(
        stuck([cdnImage], {
          settleOmitted: 14,
          settlePending: [
            `1 request to /${'a'.repeat(98)}… in flight (Image)`,
            '14 more requests in flight',
          ],
        }),
      ),
    );
    expect(f.cause).toBe('settle-timeout');
    expect(f.confidence).toBe('low');
  });

  it('settle-timeout: a report without full URLs names no rule', () => {
    const f = classifyFlake(
      obs({ settleTimedOut: true, settlePending: pending, flags: ['settle-timeout'] }),
    );
    expect(f.cause).toBe('settle-timeout');
    expect(f.confidence).toBe('low');
    expect(f.fix).toBeNull();
  });

  it('settle-timeout: a pending timer is not a request, so it is not this cause', () => {
    const f = classifyFlake(
      obs({
        settleTimedOut: true,
        settlePending: ['1 timer due within 1000 ms'],
        flags: ['settle-timeout'],
      }),
    );
    expect(f.cause).toBe('unknown');
    expect(f.evidence.pending).toEqual(['1 timer due within 1000 ms']);
  });

  it('settle-timeout: a changed third-party image outranks a pending request', () => {
    const f = classifyFlake(
      obs(
        stuck([{ url: 'https://api.example.com/feed', type: 'Fetch' }], {
          externals: [image],
        }),
      ),
    );
    expect(f.cause).toBe('external-image');
  });

  it('external-image: a third-party image where the pixels changed', () => {
    const f = classifyFlake(obs({ externals: [image] }));
    expect(f.cause).toBe('external-image');
    expect(f.confidence).toBe('high');
    expect(f.evidence).toEqual({
      selector: '.card img',
      url: 'https://picsum.photos/200',
      host: 'picsum.photos',
    });
    expect(f.fix).toEqual({
      stories: { 'card--basic': { network: { external: { images: 'placeholder' } } } },
    });
  });

  it('external-image: a CSS background counts the same as an <img>', () => {
    const f = classifyFlake(
      obs({
        externals: [{ ...image, ref: { ...image.ref, kind: 'background' } }],
      }),
    );
    expect(f.cause).toBe('external-image');
  });

  it('external-image: not suggested when images are already placeholdered', () => {
    const f = classifyFlake(
      obs({ externals: [image], covered: { images: true, frames: false } }),
    );
    expect(f.cause).not.toBe('external-image');
  });

  it('embed: a third-party frame where the pixels changed', () => {
    const f = classifyFlake(obs({ externals: [frame] }));
    expect(f.cause).toBe('embed');
    expect(f.evidence.host).toBe('www.youtube.com');
    expect(f.fix).toEqual({
      stories: { 'card--basic': { network: { external: { frames: 'placeholder' } } } },
    });
  });

  it('order-dependence: a reused renderer with freshRenderer off gets the project setting', () => {
    const f = classifyFlake(
      obs({ flags: ['renderer-reused'], reused: ['second'], freshRendererOn: false }),
    );
    expect(f.cause).toBe('order-dependence');
    expect(f.confidence).toBe('medium');
    expect(f.evidence.reusedIn).toEqual(['second']);
    // freshRenderer is a project option with no per-story form.
    expect(f.fix).toEqual({ freshRenderer: true });
    expect(describeFlake(f)).toMatch(
      /fix: freshRenderer = true \(project setting\) \(medium confidence\)$/,
    );
  });

  it('order-dependence: not suggested when freshRenderer is already on', () => {
    const f = classifyFlake(
      obs({ flags: ['renderer-reused'], reused: ['first'], freshRendererOn: true }),
    );
    expect(f.cause).not.toBe('order-dependence');
  });

  it('order-dependence: either capture reusing is enough, both named', () => {
    const f = classifyFlake(obs({ reused: ['first', 'second'] }));
    expect(f.evidence.reusedIn).toEqual(['first', 'second']);
  });

  it('async-element: an element in one capture only gets waitForSelector', () => {
    const f = classifyFlake(obs({ oneSided: [late] }));
    expect(f.cause).toBe('async-element');
    expect(f.confidence).toBe('medium');
    expect(f.evidence).toEqual({ selector: '.results', presentIn: 'second' });
    expect(f.fix).toEqual({
      stories: { 'card--basic': { waitForSelector: '.results' } },
    });
  });

  it('async-element: elements swapping places is content, not arrival', () => {
    const f = classifyFlake(
      obs({ oneSided: [late, { ...late, selector: '.old', presentIn: 'first' }] }),
    );
    expect(f.cause).not.toBe('async-element');
  });

  it('async-element: the largest element is the one to wait for', () => {
    const f = classifyFlake(
      obs({ oneSided: [{ ...late, selector: '.tiny', area: 4 }, late] }),
    );
    expect(f.evidence.selector).toBe('.results');
  });

  it('clock: changed time text gets a mask', () => {
    const f = classifyFlake(obs({ textChanges: [clock] }));
    expect(f.cause).toBe('clock');
    expect(f.confidence).toBe('high');
    expect(f.evidence).toEqual({ selector: '.clock', before: '10:41', after: '10:42' });
    expect(f.fix).toEqual({ stories: { 'card--basic': { mask: ['.clock'] } } });
  });

  it('clock: relative and calendar times count', () => {
    for (const [before, after] of [
      ['3 minutes ago', '4 minutes ago'],
      ['Oct 14, 2026', 'Oct 15, 2026'],
      ['2026-10-14', '2026-10-15'],
      ['1h 5m', '1h 6m'],
    ])
      expect(
        classifyFlake(obs({ textChanges: [{ selector: '.t', before, after }] })).cause,
      ).toBe('clock');
  });

  it('random-content: other changed text gets a mask, with low confidence', () => {
    const f = classifyFlake(obs({ textChanges: [quote] }));
    expect(f.cause).toBe('random-content');
    expect(f.confidence).toBe('low');
    expect(f.fix).toEqual({ stories: { 'card--basic': { mask: ['.quote'] } } });
  });

  it('random-content: "3 items" to "4 items" is not a clock', () => {
    const f = classifyFlake(
      obs({ textChanges: [{ selector: '.n', before: '3 items', after: '4 items' }] }),
    );
    expect(f.cause).toBe('random-content');
  });

  it('clock: a clock beside other text masks the clock, with medium confidence', () => {
    const f = classifyFlake(obs({ textChanges: [quote, clock] }));
    expect(f.cause).toBe('clock');
    expect(f.confidence).toBe('medium');
    expect(f.fix?.stories?.['card--basic']?.mask).toEqual(['.clock']);
  });

  it('render-drift: identical structure and a small delta has no fix', () => {
    const f = classifyFlake(obs({ structureIdentical: true, mismatchPercent: 0.02 }));
    expect(f.cause).toBe('render-drift');
    expect(f.confidence).toBe('medium');
    expect(f.fix).toBeNull();
  });

  it('render-drift: a renderer-reused capture makes it certain', () => {
    const f = classifyFlake(
      obs({
        structureIdentical: true,
        mismatchPercent: 0.02,
        flags: ['renderer-reused'],
        reused: ['second'],
        freshRendererOn: true,
      }),
    );
    expect(f.cause).toBe('render-drift');
    expect(f.confidence).toBe('high');
  });

  it('unknown: identical structure but a large delta is something moving', () => {
    const f = classifyFlake(
      obs({ structureIdentical: true, mismatchPercent: RENDER_DRIFT_MAX_PERCENT + 1 }),
    );
    expect(f.cause).toBe('unknown');
    expect(f.confidence).toBe('low');
    expect(f.fix).toBeNull();
  });

  it('unknown: nothing observed', () => {
    const f = classifyFlake(obs({}));
    expect(f).toEqual({
      cause: 'unknown',
      confidence: 'low',
      evidence: { mismatchPercent: 0.5 },
      fix: null,
    });
  });
});

describe('precedence: the first confident match wins', () => {
  const all = obs({
    ...stuck([cdnImage]),
    externals: [image, frame],
    oneSided: [late],
    reused: ['second'],
    textChanges: [clock],
    structureIdentical: true,
    mismatchPercent: 0.01,
  });
  const noSettle = {
    settleTimedOut: false,
    settleRequests: [],
    settlePending: [],
    flags: [],
  };

  it('walks the documented order as each cause is removed', () => {
    const order: Array<[FlakeCause, Partial<FlakeObservations>]> = [
      ['external-image', {}],
      ['embed', { externals: [frame] }],
      ['settle-timeout', { externals: [] }],
      ['order-dependence', { externals: [], ...noSettle }],
      ['async-element', { externals: [], ...noSettle, reused: [] }],
      ['clock', { externals: [], ...noSettle, reused: [], oneSided: [] }],
      [
        'render-drift',
        { externals: [], ...noSettle, reused: [], oneSided: [], textChanges: [] },
      ],
    ];
    for (const [cause, change] of order)
      expect(classifyFlake({ ...all, ...change }).cause).toBe(cause);
  });

  it('an image beside a frame is the image', () => {
    expect(classifyFlake(obs({ externals: [frame, image] })).cause).toBe(
      'external-image',
    );
  });

  it('a clock beside an element in one capture is the element', () => {
    expect(classifyFlake(obs({ oneSided: [late], textChanges: [clock] })).cause).toBe(
      'async-element',
    );
  });

  it('another explanation beside a third-party image lowers the confidence', () => {
    expect(
      classifyFlake(obs({ externals: [image], textChanges: [quote] })).confidence,
    ).toBe('medium');
  });

  it('the biggest overlap leads, and a tie breaks by selector', () => {
    const a = { ...image, selector: 'b.small', overlap: 10 };
    const b = { ...image, selector: 'a.big', overlap: 99 };
    expect(classifyFlake(obs({ externals: [a, b] })).evidence.selector).toBe('a.big');
    const t1 = { ...image, selector: 'z', overlap: 5 };
    const t2 = { ...image, selector: 'a', overlap: 5 };
    expect(classifyFlake(obs({ externals: [t1, t2] })).evidence.selector).toBe('a');
  });
});

describe('every fix is a patch the config accepts', () => {
  const cases: Array<[string, Partial<FlakeObservations>]> = [
    ['settle-timeout', stuck([cdnImage])],
    ['external-image', { externals: [image] }],
    ['embed', { externals: [frame] }],
    ['async-element', { oneSided: [late] }],
    ['order-dependence', { reused: ['first'] }],
    ['clock', { textChanges: [clock] }],
    ['random-content', { textChanges: [quote] }],
    ['a variant story id', { storyId: 'card--basic__dark', externals: [image] }],
  ];
  it.each(cases)('%s', (_name, o) => {
    const f = classifyFlake(obs(o));
    expect(f.fix).not.toBeNull();
    expect(accepted(f)).toBe(true);
    // Story-scoped, except the project-only freshRenderer.
    if (f.cause !== 'order-dependence')
      expect(Object.keys(f.fix!.stories!)).toEqual([o.storyId ?? 'card--basic']);
  });

  it('the test would notice a patch the schema refuses', () => {
    expect(
      Value.Check(ProjectConfigSchema, {
        stories: { a: { network: { external: 'x' } } },
      }),
    ).toBe(false);
  });

  it('every cause is exercised above', () => {
    const seen = new Set<FlakeCause>(
      [
        ...cases.map(([, o]) => classifyFlake(obs(o)).cause),
        classifyFlake(obs({ structureIdentical: true, mismatchPercent: 0 })).cause,
        classifyFlake(obs({})).cause,
      ].filter(Boolean),
    );
    expect([...seen].sort()).toEqual([...FLAKE_CAUSES].sort());
  });
});

describe('one line per flake', () => {
  it('names the host, the element and the exact assignment', () => {
    expect(describeFlake(classifyFlake(obs({ externals: [image] })))).toBe(
      'Unstable: external image from picsum.photos in .card img; fix: stories["card--basic"].network.external.images = "placeholder"',
    );
  });

  it('shows the before and after of a clock', () => {
    expect(describeFlake(classifyFlake(obs({ textChanges: [clock] })))).toBe(
      'Unstable: time text changed in .clock ("10:41" to "10:42"); fix: stories["card--basic"].mask = [".clock"]',
    );
  });

  it('says how sure it is when it is not', () => {
    expect(describeFlake(classifyFlake(obs({ textChanges: [quote] })))).toMatch(
      /\(low confidence\)$/,
    );
  });

  it('render drift points at a jux bug and freshRenderer', () => {
    const line = describeFlake(
      classifyFlake(obs({ structureIdentical: true, mismatchPercent: 0.004 })),
    );
    expect(line).toMatch(/render drift/);
    expect(line).toMatch(/jux bug/);
    expect(line).toMatch(/freshRenderer/);
    expect(line).not.toContain('\n');
  });

  it('formats a rules patch as one assignment', () => {
    expect(
      formatFix({
        stories: { a: { network: { rules: [{ match: '/x', action: 'block' }] } } },
      }),
    ).toBe('stories["a"].network.rules = [{"match":"/x","action":"block"}]');
  });
});

describe('looksLikeTime', () => {
  it.each([
    '10:42',
    '10:42:07',
    '9:05 PM',
    '2026-10-14',
    '2026-10-14T10:42:07Z',
    '10/14/2026',
    '14.10.2026',
    'Oct 14',
    '14 October 2026',
    '5 minutes ago',
    'an hour ago',
    'just now',
    'in 3 days',
    '2h 5m',
    '1m 30s',
    '1760438400',
    'Updated 3 hours ago by sam',
    'vor 5 Minuten',
    'il y a 5 minutes',
    'hace 5 minutos',
    '5 minuten geleden',
    '250ms',
    '1.5s',
    '2 hours',
    '1600000000',
    '12:30',
    'October 2026',
    'octubre de 2026',
    'Tuesday',
    'Tue',
    'Tue 14',
    'Sat, 10:30',
    'Dienstag',
    'Monday Motors', // accepted: a changed weekday word is a clock far more often
    'today',
    'Yesterday at noon',
    'tomorrow',
    '2026/10/14',
    '14 oct',
    'oct 14',
    'May 3',
    '3 March',
    '14 march 2026',
    'march 14, 2026',
    'may 2026',
    'Okt 14',
    '14. Oktober 2026',
    '14 octobre 2026',
    '14 de octubre de 2026',
    '14 ottobre 2026',
    '14 de outubro de 2026',
    '14 oktober 2026',
    '14 août',
    '2026年10月14日',
    '10月14日',
    '2026년 10월',
  ])('%s is a time', (t) => expect(looksLikeTime(t)).toBe(true));

  it.each([
    '3 items',
    'v1.2',
    'v1.2.3',
    '1.2.34',
    'Version 2.0',
    '12 of 30',
    'Page 2 of 10',
    '$1,234.50',
    '100%',
    'Room 101',
    '5 min read',
    'may 3 things',
    'ratio 3:2',
    'Score 3:15',
    'May 3 items',
    'Mar 2 results',
    'ID 1600000000',
    'Phone 1555123456',
    '250ms latency budget',
    '2 hours of footage',
    'march forward',
    'may be',
    'March forward',
    'May be',
    'mar 2 items',
    'The Sun shines',
    'Sat on the mat',
    'Wednesday1', // not a whole word
    'Tuesdays are', // not a whole word
    'v2026',
    'Item 14 of 20',
    'monkey',
    '1234567',
    '',
  ])('%s is not', (t) => expect(looksLikeTime(t)).toBe(false));
});
