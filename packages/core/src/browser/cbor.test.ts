import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CborFramer, decodeCbor, encodeCbor } from './cbor.js';
import { normalizeStructure } from '../capture/structure.js';

const bytes = (hex: string) => Buffer.from(hex.replaceAll(' ', ''), 'hex');
const envelope = (body: Buffer, legacy = false): Buffer => {
  const header = bytes(legacy ? 'd8 5a 00000000' : 'd8 18 5a 00000000');
  header.writeUInt32BE(body.length, header.length - 4);
  return Buffer.concat([header, body]);
};
const double = (n: number): Buffer => {
  const b = Buffer.alloc(9);
  b[0] = 0xfb;
  b.writeDoubleBE(n, 1);
  return b;
};

describe('CRDTP CBOR', () => {
  it('uses the Chromium envelope and indefinite maps', () => {
    const golden = bytes('d8 18 5a 00000005 bf 61 61 01 ff');
    expect(encodeCbor({ a: 1 })).toEqual(golden);
    expect(decodeCbor(golden)).toEqual({ a: 1 });
    expect(decodeCbor(envelope(bytes('bf 61 61 01 ff'), true))).toEqual({ a: 1 });
  });

  it('roundtrips strings, nesting and all numeric width boundaries', () => {
    const value = {
      numbers: [
        0,
        23,
        24,
        255,
        256,
        65535,
        65536,
        2147483647,
        -1,
        -24,
        -25,
        -256,
        -257,
        -65536,
        -65537,
        -2147483648,
        2147483648,
        Number.MAX_SAFE_INTEGER,
        -0.125,
        Number.MIN_VALUE,
        Number.MAX_VALUE,
      ],
      text: ['', 'a\0b', 'é', '漢字', '😀', '\ud800', '\udc00'],
      nested: [true, false, null, {}, [], { x: [1, { y: 'z' }] }],
    };
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
    expect(decodeCbor(bytes('63 e6 b0 b4'))).toBe('水');
    // Wire bytes demonstrate little-endian UTF16, independent of our encoder.
    expect(decodeCbor(bytes('42 34 6c'))).toBe('水');
    expect(decodeCbor(bytes('42 00 d8'))).toBe('\ud800');
    expect(encodeCbor('水')).toEqual(bytes('42 34 6c'));
  });

  it('matches Chromium JSON conversion of binary and special doubles', () => {
    expect(decodeCbor(bytes('d6 43 00 80 ff'))).toBe('AID/');
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(decodeCbor(double(n))).toBeNull();
      expect(decodeCbor(encodeCbor(n))).toBeNull();
    }
    expect(Object.is(decodeCbor(double(-0)), 0)).toBe(true);
    expect(Object.is(decodeCbor(encodeCbor(-0)), 0)).toBe(true);
  });

  it('retains own prototype keys without mutating prototypes', () => {
    const value: unknown = JSON.parse('{"__proto__":{"polluted":true},"constructor":7}');
    const actual = decodeCbor(encodeCbor(value));
    expect(actual).toEqual(value);
    expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('polluted');
    // Like JSON.parse, duplicate map keys take the last value.
    expect(decodeCbor(bytes('bf 61 61 01 61 61 02 ff'))).toEqual({ a: 2 });
  });

  it('preserves JSON omission/null semantics for undefined and sparse arrays', () => {
    const items = new Array<unknown>(3);
    items[0] = undefined;
    items[2] = 1;
    const value = { missing: undefined, items };
    expect(decodeCbor(encodeCbor(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it('rejects unsupported values, classes, cycles and excessive depth', () => {
    for (const v of [
      undefined,
      1n,
      Symbol('x'),
      () => 1,
      new Date(),
      new Map(),
      Buffer.from('x'),
    ])
      expect(() => encodeCbor(v)).toThrow('unsupported');
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => encodeCbor(cycle)).toThrow('cyclic');
    let v: unknown = 0;
    for (let i = 0; i < 300; i++) v = [v];
    expect(decodeCbor(encodeCbor(v))).toEqual(v);
    expect(() => encodeCbor([v])).toThrow('nesting');
    expect(() =>
      decodeCbor(
        Buffer.concat([Buffer.alloc(301, 0x9f), bytes('00'), Buffer.alloc(301, 0xff)]),
      ),
    ).toThrow('nesting');
  });

  it.each([
    '',
    'ff',
    'f7',
    '80',
    'a0',
    'c0 00',
    'f9 0000',
    'fa 00000000',
    '1b 0000000000000000',
    '1a 80000000',
    '3a 80000000',
    '41 00',
    '62 ff ff',
    'd6 61 61',
    'd6 42 00',
    'bf 00 01 ff',
    'bf 61 61 ff',
    '9f 01',
    'd8 18 5a 00000000',
    'd8 18 5a 00000001 00',
    'd8 18 5a 00000003 bf ff 00',
    'd8 18 5a 00000002 bf 61 61 01 ff',
    'd8 18 5a ffffffff bf ff',
    'd8 18 58 02 bf ff',
    '00 00',
  ])('rejects malformed or unsupported bytes %s', (hex) => {
    expect(() => decodeCbor(bytes(hex))).toThrow('CDP CBOR');
  });

  it('rejects every truncated prefix of a nested envelope', () => {
    const wire = encodeCbor({ nested: [{ text: '漢字', n: 65536 }] });
    for (let n = 0; n < wire.length; n++)
      expect(() => decodeCbor(wire.subarray(0, n))).toThrow('CDP CBOR');
  });

  it('preserves real Chromium snapshot JSON and normalized structure/hash', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../capture/__fixtures__/structure-basic.cdp.json', import.meta.url),
        'utf8',
      ),
    );
    const decoded = decodeCbor(encodeCbor(fixture.raw)) as typeof fixture.raw;
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(fixture.raw));
    expect(normalizeStructure(decoded, fixture.viewport)).toEqual(
      normalizeStructure(fixture.raw, fixture.viewport),
    );
  });
});

describe('CBOR pipe framing', () => {
  const messages = [
    encodeCbor({ id: 1, text: '😀\0' }),
    encodeCbor({ id: 2 }),
    envelope(bytes('bf 61 61 01 ff'), true),
  ];
  const wire = Buffer.concat(messages);

  it('handles every possible split, coalesced frames and byte-sized chunks', () => {
    for (let split = 0; split <= wire.length; split++) {
      const framer = new CborFramer();
      const out: Buffer[] = [];
      framer.push(wire.subarray(0, split), (f) => out.push(f));
      framer.push(Buffer.alloc(0), (f) => out.push(f));
      framer.push(wire.subarray(split), (f) => out.push(f));
      expect(out).toEqual(messages);
    }
    const framer = new CborFramer();
    const out: Buffer[] = [];
    for (const byte of wire) framer.push(Buffer.from([byte]), (f) => out.push(f));
    expect(out).toEqual(messages);
  });

  it('withholds incomplete frames, including a complete frame plus partial next', () => {
    const framer = new CborFramer();
    const out: Buffer[] = [];
    framer.push(wire.subarray(0, messages[0]!.length + 3), (f) => out.push(f));
    expect(out).toEqual([messages[0]]);
    framer.push(wire.subarray(messages[0]!.length + 3), (f) => out.push(f));
    expect(out).toEqual(messages);
  });

  it('bounds the declared size before buffering the body and fails closed', () => {
    const framer = new CborFramer(20);
    expect(() => framer.push(bytes('d8 18 5a 01000000'), () => {})).toThrow('byte limit');
    expect(() => framer.push(messages[1]!, () => {})).toThrow('already failed');
    const exact = new CborFramer(messages[1]!.length);
    const out: Buffer[] = [];
    exact.push(messages[1]!, (f) => out.push(f));
    expect(out).toEqual([messages[1]]);
    for (const limit of [0, -1, NaN, 1.5])
      expect(() => new CborFramer(limit)).toThrow('limit');
  });

  it.each(['00', 'd8 19', 'd8 18 59', 'd8 18 5a 00000000', 'd8 18 5a 00000002 9f ff'])(
    'rejects invalid top-level framing %s',
    (hex) => {
      expect(() => new CborFramer().push(bytes(hex), () => {})).toThrow('CDP CBOR');
    },
  );

  it('assembles a large fragmented real-shaped payload exactly', () => {
    const large = encodeCbor({
      result: {
        strings: ['漢字'.repeat(100_000)],
        indices: Array.from({ length: 40_000 }, (_, i) => i),
      },
    });
    const out: Buffer[] = [];
    const framer = new CborFramer();
    for (let offset = 0; offset < large.length; offset += 16384)
      framer.push(large.subarray(offset, offset + 16384), (f) => out.push(f));
    expect(out).toEqual([large]);
    expect(decodeCbor(out[0]!)).toEqual(decodeCbor(large));
  });
});
