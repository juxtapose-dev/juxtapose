// packages/core/src/browser/cdp.test.ts
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CdpConnection, CdpError, SendTimeoutError, TargetClosedError } from './cdp.js';
import { NullFramer, PipeTransport, type Transport } from './transport.js';

class FakeTransport implements Transport {
  sent: { id: number; method: string; params: unknown; sessionId?: string }[] = [];
  onMessage: ((m: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  send(m: string) {
    this.sent.push(JSON.parse(m));
  }
  close() {
    this.onClose?.('closed by test');
  }
  reply(id: number, result: unknown, sessionId?: string) {
    this.onMessage?.(JSON.stringify({ id, result, sessionId }));
  }
  fail(id: number, code: number, message: string) {
    this.onMessage?.(JSON.stringify({ id, error: { code, message } }));
  }
  event(method: string, params: unknown, sessionId?: string) {
    this.onMessage?.(JSON.stringify({ method, params, sessionId }));
  }
}

const isLifecycle = (p: unknown): p is { name: string } =>
  typeof p === 'object' && p !== null && 'name' in p;

describe('CdpConnection', () => {
  it('matches replies by id and carries sessionId', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const p = c.send<{ product: string }>('Browser.getVersion');
    const q = c.send('Page.enable', {}, 'S1');
    expect(t.sent).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Page.enable', params: {}, sessionId: 'S1' },
    ]);
    t.reply(2, {}, 'S1');
    t.reply(1, { product: 'HeadlessChrome/151' });
    expect((await p).product).toBe('HeadlessChrome/151');
    await q;
  });
  it('rejects with CdpError carrying the protocol code and method', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const p = c.send('Runtime.evaluate', { expression: 'x' }, 'S1');
    t.fail(1, -32000, 'Cannot find context');
    await expect(p).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CdpError &&
        e.code === -32000 &&
        /Runtime\.evaluate.*Cannot find context/.test(e.message),
    );
  });
  it('routes events by sessionId and supports once with a predicate', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const got: string[] = [];
    const off = c.on(
      'Page.lifecycleEvent',
      (p) => isLifecycle(p) && got.push('S1:' + p.name),
      'S1',
    );
    c.on('Page.lifecycleEvent', (p) => isLifecycle(p) && got.push('S2:' + p.name), 'S2');
    const load = c.once<{ name: string }>(
      'Page.lifecycleEvent',
      'S1',
      (p) => p.name === 'load',
    );
    t.event('Page.lifecycleEvent', { name: 'init' }, 'S1');
    t.event('Page.lifecycleEvent', { name: 'load' }, 'S2');
    t.event('Page.lifecycleEvent', { name: 'load' }, 'S1');
    expect((await load).name).toBe('load');
    off();
    t.event('Page.lifecycleEvent', { name: 'DOMContentLoaded' }, 'S1');
    expect(got).toEqual(['S1:init', 'S2:load', 'S1:load']);
  });
  it('transport close rejects pending sends, pending once, and future sends with TargetClosedError', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const pending = c.send('Page.navigate', { url: 'x' }, 'S1');
    const waiting = c.once('Page.lifecycleEvent', 'S1');
    let reason: string | undefined;
    c.onClose = (r) => (reason = r);
    t.close();
    await expect(pending).rejects.toBeInstanceOf(TargetClosedError);
    await expect(waiting).rejects.toBeInstanceOf(TargetClosedError);
    await expect(c.send('Browser.getVersion')).rejects.toBeInstanceOf(TargetClosedError);
    expect(c.closed).toBe(true);
    expect(reason).toBe('closed by test');
  });
  it('a send that gets no reply rejects at its node-side timeout', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    await expect(
      c.send('Runtime.evaluate', { expression: 'while(true){}' }, 'S1', { timeout: 20 }),
    ).rejects.toBeInstanceOf(SendTimeoutError);
    t.reply(1, {}); // a late reply must not throw
  });
  it('allocateId and sendRaw share one id space with send', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const p = c.send('Browser.getVersion'); // id 1
    const raw = c.allocateId(); // id 2
    c.sendRaw({ id: raw, method: 'Target.getTargets', params: {} });
    const q = c.send('Target.getBrowserContexts'); // id 3, never 2
    expect(t.sent.map((m) => m.id)).toEqual([1, 2, 3]);
    t.reply(1, { product: 'x' });
    t.reply(3, { browserContextIds: [] });
    await p;
    await q;
  });
  it('onRaw sees every parsed frame, including replies to raw ids', () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const seen: number[] = [];
    c.onRaw = (m) => m.id !== undefined && seen.push(m.id);
    c.sendRaw({ id: c.allocateId(), method: 'Target.getTargets', params: {} });
    t.reply(1, { targetInfos: [] });
    t.event('Target.targetCreated', {});
    expect(seen).toEqual([1]);
  });
  it('tolerates a message that is not json', () => {
    const t = new FakeTransport();
    new CdpConnection(t);
    expect(() => t.onMessage?.('not json')).not.toThrow();
  });
});

describe('CdpConnection hardening', () => {
  it('names the method in the rejection of every pending command when the transport closes', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const a = c.send('Page.navigate', { url: 'x' }, 'S1');
    const b = c.send('Runtime.evaluate', { expression: '1' }, 'S1');
    t.close();
    await expect(a).rejects.toThrow(/Page\.navigate/);
    await expect(b).rejects.toThrow(/Runtime\.evaluate/);
    await expect(a).rejects.toBeInstanceOf(TargetClosedError);
  });
  it('a send after close names its method too', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    t.close();
    await expect(c.send('Browser.getVersion')).rejects.toThrow(/Browser\.getVersion/);
  });
  describe('timer and pending bookkeeping', () => {
    afterEach(() => vi.useRealTimers());
    it('a timed-out send leaves no pending entry or timer, and a late reply is dropped', async () => {
      vi.useFakeTimers();
      const t = new FakeTransport();
      const c = new CdpConnection(t);
      const seen: number[] = [];
      c.onRaw = (m) => m.id !== undefined && seen.push(m.id);
      const p = c.send('X.y', {}, undefined, { timeout: 10 });
      const assertion = expect(p).rejects.toBeInstanceOf(SendTimeoutError);
      expect(c.pendingCount).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(c.pendingCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(() => t.reply(1, {})).not.toThrow();
      expect(() => t.fail(1, -1, 'late')).not.toThrow();
      expect(seen).toEqual([1, 1]);
    });
    it('a reply clears the pending entry and its timer', async () => {
      vi.useFakeTimers();
      const t = new FakeTransport();
      const c = new CdpConnection(t);
      const p = c.send('A.b', {}, undefined, { timeout: 15 });
      expect(vi.getTimerCount()).toBe(1);
      t.reply(1, { ok: true });
      await expect(p).resolves.toEqual({ ok: true });
      expect(c.pendingCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('a transport that throws on send rejects the send and cleans up', async () => {
      vi.useFakeTimers();
      const t = new FakeTransport();
      t.send = () => {
        throw new Error('EPIPE');
      };
      const c = new CdpConnection(t);
      await expect(c.send('A.b')).rejects.toThrow(/EPIPE/);
      expect(c.pendingCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
  it('a throwing event handler or onRaw does not stop later frames in the same chunk', async () => {
    const uncaught: unknown[] = [];
    const spy = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', spy);
    try {
      const t = new FakeTransport();
      const c = new CdpConnection(t);
      const errors: string[] = [];
      c.onError = (e, where) => errors.push(`${where}:${(e as Error).message}`);
      c.on('E.one', () => {
        throw new Error('boom');
      });
      let n = 0;
      c.on('E.one', () => n++); // a sibling handler still runs
      c.onRaw = (m) => {
        if (m.method === 'E.one') throw new Error('raw boom');
      };
      const p = c.send('A.b');
      t.onMessage?.(
        JSON.stringify({ method: 'E.one', params: {} }) +
          '' /* one frame per call, as the framer delivers */,
      );
      t.reply(1, { ok: 1 });
      await expect(p).resolves.toEqual({ ok: 1 });
      expect(n).toBe(1);
      expect(errors).toEqual(['onRaw:raw boom', 'handler:boom']);
      await new Promise((r) => setTimeout(r, 10));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', spy);
    }
  });
  it('through a PipeTransport, a throwing handler does not drop the reply in the same chunk', async () => {
    const out = new PassThrough();
    const inp = new PassThrough();
    const c = new CdpConnection(new PipeTransport(out, inp));
    c.onError = () => undefined;
    c.on('E.one', () => {
      throw new Error('boom');
    });
    const p = c.send('A.b');
    inp.write('{"method":"E.one","params":{}}\0{"id":1,"result":{"ok":2}}\0');
    await expect(p).resolves.toEqual({ ok: 2 });
  });
  it('the default onError reports one line to stderr', () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      c.on('E.one', () => {
        throw new Error('boom');
      });
      t.event('E.one', {});
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).toMatch(/^jux: .*boom.*\n$/);
    } finally {
      write.mockRestore();
    }
  });
  it('off() removes the handler key once its set is empty', () => {
    const c = new CdpConnection(new FakeTransport());
    const off1 = c.on('E.one', () => undefined, 'S1');
    const off2 = c.on('E.one', () => undefined, 'S1');
    expect(c.handlerKeyCount).toBe(1);
    off1();
    expect(c.handlerKeyCount).toBe(1);
    off2();
    expect(c.handlerKeyCount).toBe(0);
  });
  it('once after close rejects with a TargetClosedError that carries the close reason and method', async () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    t.close();
    const e = await c.once('Page.lifecycleEvent', 'S1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TargetClosedError);
    expect((e as Error).message).toMatch(/closed by test.*Page\.lifecycleEvent/);
  });
  it('sendRaw after close throws TargetClosedError', () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    t.close();
    expect(() => c.sendRaw({ id: c.allocateId(), method: 'A.b' })).toThrow(
      TargetClosedError,
    );
  });
  it('produces no unhandled rejections across timeout, close and late replies', async () => {
    const unhandled: unknown[] = [];
    const spy = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', spy);
    try {
      const t = new FakeTransport();
      const c = new CdpConnection(t);
      const timedOut = c.send('A.timeout', {}, undefined, { timeout: 10 });
      const pending = c.send('A.pending');
      const waiting = c.once('E.vent');
      await timedOut.catch(() => undefined);
      t.reply(1, {});
      t.close();
      await pending.catch(() => undefined);
      await waiting.catch(() => undefined);
      await c.send('A.after').catch(() => undefined);
      // Unhandled rejections surface on a later macrotask.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', spy);
    }
  });
  it('close() on the connection closes once and fires onClose once', () => {
    const t = new FakeTransport();
    const c = new CdpConnection(t);
    let n = 0;
    c.onClose = () => n++;
    c.close();
    c.close();
    expect(n).toBe(1);
  });
});

describe('PipeTransport', () => {
  const make = () => {
    const out = new PassThrough();
    const inp = new PassThrough();
    const t = new PipeTransport(out, inp);
    const got: string[] = [];
    t.onMessage = (m) => got.push(m);
    return { t, out, inp, got };
  };
  it('reassembles a frame split across data chunks', () => {
    const { inp, got } = make();
    inp.write('{"id":1,"res');
    inp.write('ult":{}');
    expect(got).toEqual([]);
    inp.write('}\0');
    expect(got).toEqual(['{"id":1,"result":{}}']);
  });
  it('delivers several frames from one chunk, in order', () => {
    const { inp, got } = make();
    inp.write('{"a":1}\0{"b":2}\0{"c"');
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
    inp.write(':3}\0');
    expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
  it('keeps a multi-byte character intact when its bytes straddle chunks', () => {
    const { inp, got } = make();
    const bytes = Buffer.from('{"t":"\u{1F600}é"}\0');
    const cut = bytes.indexOf(0xf0) + 2; // mid-emoji
    inp.write(bytes.subarray(0, cut));
    inp.write(bytes.subarray(cut));
    expect(got).toEqual(['{"t":"\u{1F600}é"}']);
  });
  it('close() stops reading', () => {
    const { t, inp, got } = make();
    t.close();
    inp.write('{"a":1}\0');
    expect(got).toEqual([]);
    expect(inp.listenerCount('data')).toBe(0);
  });
  it('NUL-terminates what it writes', () => {
    const { t, out } = make();
    t.send('{"id":1}');
    expect(out.read().toString()).toBe('{"id":1}\0');
  });
  it('reports close once when the readable closes, and a CdpConnection rejects pending', async () => {
    const { t, inp } = make();
    const c = new CdpConnection(t);
    const p = c.send('Page.navigate');
    inp.destroy();
    await expect(p).rejects.toThrow(/Page\.navigate/);
    expect(c.closed).toBe(true);
  });
});

describe('NullFramer scale', () => {
  it('frames a 20 MB frame delivered in 64 KB chunks in under 100 ms', () => {
    const f = new NullFramer();
    const frames: number[] = [];
    const body = Buffer.alloc(20 * 1024 * 1024, 0x61);
    const wire = Buffer.concat([body, Buffer.from('\0')]);
    const start = performance.now();
    for (let i = 0; i < wire.length; i += 65536)
      f.push(wire.subarray(i, i + 65536), (s) => frames.push(s.length));
    const ms = performance.now() - start;
    console.log(`20 MB framed in ${ms.toFixed(1)} ms`);
    expect(frames).toEqual([body.length]);
    expect(ms).toBeLessThan(100);
  });
  it('still decodes a multi-byte character split across chunks', () => {
    const f = new NullFramer();
    const out: string[] = [];
    const b = Buffer.from('é😀\0');
    f.push(b.subarray(0, 1), (s) => out.push(s));
    f.push(b.subarray(1, 4), (s) => out.push(s));
    f.push(b.subarray(4), (s) => out.push(s));
    expect(out).toEqual(['é😀']);
  });
});

describe('NullFramer', () => {
  it('splits on NUL across chunk boundaries', () => {
    const f = new NullFramer();
    const out: string[] = [];
    f.push('{"a":1}\0{"b"', (s) => out.push(s));
    f.push(':2}\0', (s) => out.push(s));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});
