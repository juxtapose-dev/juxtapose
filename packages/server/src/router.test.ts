import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serve, type ServeHandle } from './serve.js';
import type { ReviewSource, ReviewBundle, RunProgress, ImageKind } from './types.js';
import type { StoryManifest } from '@juxtapose/core';

/** Records what the HTTP layer asked for, so tests assert on the contract
 *  rather than on a real capture pipeline. */
class FakeSource implements ReviewSource {
  approved: string[] = [];
  runCalls: (string[] | undefined)[] = [];
  cancelled = 0;
  images = new Map<string, Buffer>();
  handoffText: string | null = 'PROMPT';
  approveError: Error | null = null;

  async bundle(): Promise<ReviewBundle> {
    return { report: null, approved: this.approved, running: false };
  }
  async progress(): Promise<RunProgress> {
    return { running: true, done: 2, total: 5, storyId: 'a--b' };
  }
  async stories(): Promise<StoryManifest[]> {
    return [
      { storyId: 'a--b', title: 'A', name: 'B', componentPath: '/x.tsx', params: {} },
    ];
  }
  async image(kind: ImageKind, storyId: string): Promise<Buffer | null> {
    return this.images.get(`${kind}:${storyId}`) ?? null;
  }
  async handoff(): Promise<string | null> {
    return this.handoffText;
  }
  async approve(storyId: string): Promise<void> {
    if (this.approveError) throw this.approveError;
    this.approved.push(storyId);
  }
  async run(storyIds?: string[]): Promise<void> {
    this.runCalls.push(storyIds);
  }
  async cancel(): Promise<void> {
    this.cancelled++;
  }
  affectedFor: string[] = ['a--b', 'a--c'];
  affectedCalls: string[] = [];
  flushes = 0;
  async affected(storyId: string): Promise<string[]> {
    this.affectedCalls.push(storyId);
    return this.affectedFor;
  }
  async flushIndex(): Promise<void> {
    this.flushes++;
  }
}

let source: FakeSource;
let handle: ServeHandle;
const api = (p: string) => `${handle.url}/jux/api${p}`;

beforeEach(async () => {
  source = new FakeSource();
  handle = await serve(source);
});
afterEach(async () => {
  await handle.close();
});

describe('review API', () => {
  it('serves the bundle the panel polls', async () => {
    const res = await fetch(api('/bundle'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: null, approved: [], running: false });
  });

  it('reports run progress', async () => {
    expect(await (await fetch(api('/progress'))).json()).toEqual({
      running: true,
      done: 2,
      total: 5,
      storyId: 'a--b',
    });
  });

  it('serves images as webp and caches them hard', async () => {
    source.images.set('current:a--b', Buffer.from('webp-bytes'));
    const res = await fetch(api('/image/current/a--b'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    // The client cache-busts with ?v=, so bytes at a given URL never change.
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('404s a missing image rather than serving an empty body', async () => {
    expect((await fetch(api('/image/current/nope'))).status).toBe(404);
  });

  it('rejects an unknown image kind', async () => {
    expect((await fetch(api('/image/bogus/a--b'))).status).toBe(400);
  });

  it('handles story ids containing slashes', async () => {
    source.images.set('current:group/a--b', Buffer.from('x'));
    const res = await fetch(api(`/image/current/${encodeURIComponent('group/a--b')}`));
    expect(res.status).toBe(200);
  });

  it('serves the handoff prompt as plain text', async () => {
    const res = await fetch(api('/handoff/a--b'));
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('PROMPT');
  });

  it('404s a handoff for a story not in the run', async () => {
    source.handoffText = null;
    expect((await fetch(api('/handoff/ghost'))).status).toBe(404);
  });

  it('approves a story', async () => {
    const res = await fetch(api('/approve'), {
      method: 'POST',
      body: JSON.stringify({ storyId: 'a--b' }),
    });
    expect(res.status).toBe(200);
    expect(source.approved).toEqual(['a--b']);
  });

  it('rejects an approve with no storyId', async () => {
    const res = await fetch(api('/approve'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(source.approved).toEqual([]);
  });

  it('surfaces a failed approval as a 500 rather than a silent success', async () => {
    source.approveError = new Error('no capture for that story');
    const res = await fetch(api('/approve'), {
      method: 'POST',
      body: JSON.stringify({ storyId: 'a--b' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('no capture');
  });

  it('returns 202 immediately for a run instead of blocking', async () => {
    // A capture takes seconds; holding the request open would time out. The
    // client polls /progress instead.
    const res = await fetch(api('/run'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
  });

  it('passes a story subset through to a partial run', async () => {
    await fetch(api('/run'), {
      method: 'POST',
      body: JSON.stringify({ storyIds: ['a--b'] }),
    });
    // The run is fire-and-forget, so give the microtask a beat to land.
    await new Promise((r) => setTimeout(r, 20));
    expect(source.runCalls).toEqual([['a--b']]);
  });

  it('refuses a storyIds that is not a list of ids, instead of running on it', async () => {
    const res = await fetch(api('/run'), {
      method: 'POST',
      body: JSON.stringify({ storyIds: 'a--b' }),
    });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(source.runCalls).toEqual([]);
  });

  it('cancels a run', async () => {
    expect((await fetch(api('/cancel'), { method: 'POST' })).status).toBe(200);
    expect(source.cancelled).toBe(1);
  });

  it('404s an unknown route under the prefix', async () => {
    expect((await fetch(api('/nope'))).status).toBe(404);
  });

  it('answers which stories a rerender should recapture', async () => {
    const res = await fetch(api('/affected?storyId=a--b'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ storyIds: ['a--b', 'a--c'] });
    expect(source.affectedCalls).toEqual(['a--b']);
  });

  it('rejects an affected query with no story', async () => {
    expect((await fetch(api('/affected'))).status).toBe(400);
  });

  it('preserves a story id containing a query character', async () => {
    // Ids come from the platform. Splitting the URL on every '?' would
    // truncate one, and the recapture would silently target the wrong story.
    await fetch(api(`/affected?storyId=${encodeURIComponent('a--b?c')}`));
    expect(source.affectedCalls).toEqual(['a--b?c']);
  });

  it('flushes the story index when the workbench says it changed', async () => {
    expect((await fetch(api('/flush-index'), { method: 'POST' })).status).toBe(200);
    expect(source.flushes).toBe(1);
  });

  it('does not claim requests outside its prefix', async () => {
    // The addon mounts this inside a dev server; anything not ours has to
    // fall through so the workbench can serve it.
    const res = await fetch(`${handle.url}/iframe.html`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });
});
