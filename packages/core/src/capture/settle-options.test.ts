import { describe, expect, it } from 'vitest';
import {
  checkProjectSettle,
  checkSettle,
  DEFAULT_SETTLE_TIMEOUT_MS,
  layerScalars,
  matchPattern,
  mergeSettle,
  parsePattern,
  resolveSettle,
  SettleConfigError,
} from './settle-options.js';
import { expandVariants, mergeLiveParams, VariantConfigError } from './variants.js';
import { describePending, NetworkTracker, type IdleSnapshot } from './idle.js';
import type { Page } from '../browser/page.js';
import type { StoryManifest } from '../types.js';

const matches = (pattern: string, url: string, type?: string) =>
  matchPattern(parsePattern(pattern), url, type);

describe('URL patterns', () => {
  it('a glob starting with / matches the path, not the query or the host', () => {
    expect(matches('/api/feed', 'http://localhost:6006/api/feed?page=2')).toBe(true);
    expect(matches('/api/feed', 'http://localhost:6006/api/feed/2')).toBe(false);
    expect(matches('/api/*', 'http://x/api/feed')).toBe(true);
    expect(matches('/api/*', 'http://x/api/feed/2')).toBe(false);
    expect(matches('/api/**', 'http://x/api/feed/2')).toBe(true);
    expect(matches('/a?c', 'http://x/abc')).toBe(true);
  });

  it('any other glob matches the whole URL', () => {
    expect(matches('**/poll*', 'https://cdn.example.com/v1/poll?x=1')).toBe(true);
    expect(matches('https://*.example.com/**', 'https://cdn.example.com/a/b')).toBe(true);
    expect(matches('https://*.example.com/**', 'https://example.org/a')).toBe(false);
    // Regex metacharacters are literal.
    expect(matches('/a.b', 'http://x/aXb')).toBe(false);
  });

  it('type: narrows by resource type, case-insensitively, alone or with a glob', () => {
    expect(matches('type:websocket', 'ws://x/socket', 'WebSocket')).toBe(true);
    expect(matches('type:Fetch /api/*', 'http://x/api/a', 'Fetch')).toBe(true);
    expect(matches('type:Fetch /api/*', 'http://x/api/a', 'XHR')).toBe(false);
    // A request with no type is Other.
    expect(matches('type:Other', 'http://x/', undefined)).toBe(true);
  });

  it('rejects an empty pattern, an unknown type, two types or two globs', () => {
    expect(() => parsePattern(' ')).toThrow('must not be empty');
    expect(() => parsePattern('type:Socket')).toThrow("unknown resource type 'Socket'");
    expect(() => parsePattern('type:Fetch type:XHR')).toThrow('two types');
    expect(() => parsePattern('/a /b')).toThrow('two URL globs');
  });
});

describe('settle layering', () => {
  it('built-in defaults: 1500 ms cap, 1000 ms timer horizon, the four ignored types', () => {
    const s = resolveSettle();
    expect(s.timeoutMs).toBe(DEFAULT_SETTLE_TIMEOUT_MS);
    expect(s.horizonMs).toBe(1000);
    expect(s.ready).toBe(false);
    expect(s.ignore.map((p) => p.source)).toEqual([
      'type:WebSocket',
      'type:EventSource',
      'type:Ping',
      'type:Prefetch',
    ]);
    expect(s.require).toEqual([]);
  });

  it('later layers override scalars and add to lists', () => {
    const project = { timeout: 3000, network: { ignore: ['/analytics'] } };
    const story = { ready: true, network: { ignore: ['/poll'], require: ['/api/feed'] } };
    const call = { timeout: 800, network: { ignore: ['/poll'] } };
    const s = resolveSettle(project, story, call);
    expect(s.timeoutMs).toBe(800);
    expect(s.ready).toBe(true);
    expect(s.ignore.map((p) => p.source).slice(4)).toEqual(['/analytics', '/poll']);
    expect(s.require.map((p) => p.source)).toEqual(['/api/feed']);
  });

  it('the timer horizon stays below a small cap', () => {
    expect(resolveSettle({ timeout: 600 }).horizonMs).toBe(400);
    expect(resolveSettle({ timeout: 10_000 }).horizonMs).toBe(1000);
  });

  it('mergeSettle leaves keys neither side sets absent', () => {
    expect(mergeSettle({ timeout: 1 }, { ready: true })).toEqual({
      timeout: 1,
      ready: true,
    });
    expect(mergeSettle(undefined, undefined)).toBeUndefined();
  });

  it('waitForSelector and delay: call over story over project', () => {
    expect(layerScalars({ delay: 5, waitForSelector: '#p' }, {}, undefined)).toEqual({
      delay: 5,
      waitForSelector: '#p',
    });
    expect(layerScalars({ delay: 5 }, { delay: 10 }, { delay: 0 })).toEqual({ delay: 0 });
    expect(layerScalars(undefined, {}, undefined)).toEqual({});
  });
});

const story = (params: StoryManifest['params']): StoryManifest => ({
  storyId: 'feed--default',
  title: 'Feed',
  name: 'Default',
  componentPath: '',
  params,
});

describe('settle in story params and variants', () => {
  it("a variant's settle merges with the story's instead of replacing it", () => {
    const [, mobile] = expandVariants([
      story({
        settle: { network: { ignore: ['/poll'] } },
        variants: { mobile: { settle: { timeout: 4000 } } },
      }),
    ]);
    expect(mobile!.params.settle).toEqual({
      timeout: 4000,
      network: { ignore: ['/poll'] },
    });
    // Live params (the story's own declaration) merge under the variant.
    const live = mergeLiveParams(mobile!, {
      settle: { network: { ignore: ['/poll', '/x'] } },
    });
    expect(live.settle).toEqual({ timeout: 4000, network: { ignore: ['/poll', '/x'] } });
  });

  it('a default capture without settle serializes exactly as before', () => {
    const [only] = expandVariants([story({ delay: 5 })]);
    expect(only!.params).toEqual({ delay: 5 });
  });

  it('a bad settle is a declaration error naming the story or variant', () => {
    expect(() => expandVariants([story({ settle: { timeout: 0 } })])).toThrow(
      "jux: story 'feed--default': settle.timeout must be a whole number of ms from 1 to 60000, got 0",
    );
    expect(() =>
      expandVariants([
        story({
          variants: { dark: { settle: { network: { require: ['type:Nope'] } } } },
        }),
      ]),
    ).toThrow(
      "story 'feed--default': variant 'dark': settle.network.require: pattern 'type:Nope': unknown resource type 'Nope'",
    );
    // Reported where VariantConfigError is: exit 2 in run and init.
    expect(() => expandVariants([story({ settle: { wait: 1 } as never })])).toThrow(
      VariantConfigError,
    );
  });

  it('checks the project config, naming it', () => {
    expect(() => checkProjectSettle({ settle: { ready: 'yes' } })).toThrow(
      'jux: project config: settle.ready must be true or false, got "yes"',
    );
    expect(() => checkProjectSettle({ delay: -1 })).toThrow(SettleConfigError);
    expect(() => checkProjectSettle({ waitForSelector: 3 })).toThrow('CSS selector');
    expect(() =>
      checkProjectSettle({
        settle: { timeout: 2500, network: { ignore: ['/a'] } },
        delay: 0,
      }),
    ).not.toThrow();
    expect(checkSettle(undefined, 'x')).toBeUndefined();
  });
});

/** A Page that only delivers the events the tracker subscribes to. */
function eventPage() {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const page = {
    on: (event: string, h: (p: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
  } as unknown as Page & Required<Pick<Page, 'on'>>;
  const emit = (event: string, p: unknown) => handlers.get(event)?.forEach((h) => h(p));
  return { page, emit };
}

const quietSnap: IdleSnapshot = {
  timers: 0,
  rafs: 0,
  msgs: 0,
  delivered: 0,
  workers: 0,
  workerSrcs: [],
  mut: 1,
  fonts: 'loaded',
  images: 0,
  imageSrcs: [],
  ready: true,
};

describe('pending descriptions', () => {
  it('names each request in flight by path and type, and each missing required request', () => {
    const { page, emit } = eventPage();
    const net = new NetworkTracker(page, 'main');
    const send = (requestId: string, url: string, type: string, loaderId = 'L1') =>
      emit('Network.requestWillBeSent', {
        requestId,
        request: { url },
        type,
        frameId: 'main',
        loaderId,
      });
    const commit = (loaderId: string) =>
      emit('Page.frameNavigated', { frame: { id: 'main', loaderId } });
    commit('L1');
    send('1', 'http://localhost:1/api/feed?page=1', 'Fetch');
    send('2', 'http://localhost:1/api/feed?page=1', 'Fetch');
    send('3', 'http://localhost:1/events', 'EventSource');
    send('4', 'http://localhost:1/done', 'Fetch');
    emit('Network.loadingFinished', { requestId: '4' });
    const s = resolveSettle({ network: { require: ['/done', '/api/user'] } });
    expect(describePending(quietSnap, net, s)).toEqual([
      '2 requests to /api/feed?page=1 in flight (Fetch)',
      "no request matching required pattern '/api/user' has completed",
    ]);
    // A navigation that has not committed changes nothing: its document
    // request is not counted, the live document's requests still are, and
    // its own early requests wait for the commit.
    send('5', 'http://localhost:1/', 'Document', 'L2');
    send('6', 'http://localhost:1/api/next', 'Fetch', 'L2');
    expect(net.counted(s).map((r) => r.url)).toEqual([
      'http://localhost:1/api/feed?page=1',
      'http://localhost:1/api/feed?page=1',
    ]);
    // The commit forgets the old document's requests and completions.
    commit('L2');
    expect(net.counted(s).map((r) => r.url)).toEqual([
      'http://localhost:1/',
      'http://localhost:1/api/next',
    ]);
    expect(net.missing(s)).toEqual(['/done', '/api/user']);
  });

  it('require wins over ignore: a required EventSource counts', () => {
    const { page, emit } = eventPage();
    const net = new NetworkTracker(page, 'main');
    emit('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'http://x/stream' },
      type: 'EventSource',
      frameId: 'main',
    });
    expect(net.busy(resolveSettle())).toBe(false);
    expect(net.busy(resolveSettle({ network: { require: ['/stream'] } }))).toBe(true);
  });

  it('names page-side work, and is never empty', () => {
    const s = resolveSettle({ ready: true });
    expect(
      describePending(
        {
          ...quietSnap,
          timers: 2,
          rafs: 1,
          msgs: 1,
          fonts: 'loading',
          workers: 1,
          workerSrcs: ['http://x/w.js'],
          images: 1,
          imageSrcs: ['http://x/hero.png'],
          ready: false,
        },
        null,
        s,
      ),
    ).toEqual([
      'window.__juxtapose.ready() was not called',
      '2 timers due within 1000 ms',
      '1 animation frame callback pending',
      '1 posted message undelivered',
      '1 worker not answered yet: /w.js',
      'web fonts still loading',
      '1 image still loading: /hero.png',
    ]);
    expect(
      describePending({ ...quietSnap, changing: true }, null, resolveSettle()),
    ).toEqual(['the DOM kept changing']);
    expect(describePending(undefined, null, resolveSettle())).toEqual([
      'the page did not settle within 1500 ms',
    ]);
  });
});
