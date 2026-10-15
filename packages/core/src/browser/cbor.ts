// Chromium's CRDTP dialect, not general-purpose CBOR. Pinned source:
// chromium/151.0.7922.34/third_party/inspector_protocol/crdtp/{cbor,json}.cc.
// Chrome already serializes responses this way internally; keeping the pipe
// binary avoids its renderer/browser JSON conversions for large DOM snapshots.
import { isUtf8 } from 'node:buffer';

const MAX_DEPTH = 300;
const MAX_INT32 = 0x7fffffff;
const MAX_LENGTH = 0xffffffff;

function invalid(reason: string): never {
  throw new Error(`jux: invalid CDP CBOR: ${reason}`);
}

/** Returns the complete frame size once its envelope header has arrived. */
function frameSize(header: Buffer): number | undefined {
  if (!header.length) return undefined;
  if (header[0] !== 0xd8) invalid('missing envelope');
  if (header.length < 2) return undefined;
  // Chromium accepts the legacy d8 5a prefix as well as RFC-compliant d8 18 5a.
  const offset = header[1] === 0x18 ? 2 : 1;
  if (header.length <= offset) return undefined;
  if (header[offset] !== 0x5a) invalid('envelope needs a uint32 byte length');
  if (header.length < offset + 5) return undefined;
  const length = header.readUInt32BE(offset + 1);
  if (length < 2) invalid('empty envelope');
  return offset + 5 + length;
}

/** Decode CRDTP values into the values its JSON transport would have returned. */
export function decodeCbor(buffer: Buffer): unknown {
  let pos = 0;
  const need = (bytes: number, end: number) => {
    if (bytes > end - pos) invalid('truncated value');
  };
  const length = (info: number, end: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1, end);
      return buffer[pos++]!;
    }
    if (info === 25) {
      need(2, end);
      const n = buffer.readUInt16BE(pos);
      pos += 2;
      return n;
    }
    if (info === 26) {
      need(4, end);
      const n = buffer.readUInt32BE(pos);
      pos += 4;
      return n;
    }
    return invalid('unsupported length/integer width');
  };
  const value = (depth: number, end: number): unknown => {
    if (depth > MAX_DEPTH) invalid('nesting exceeds 300');
    need(1, end);
    const token = buffer[pos++]!;
    if (token === 0xd8) {
      need(1, end);
      if (buffer[pos] === 0x18) pos++;
      need(1, end);
      if (buffer[pos++] !== 0x5a) invalid('envelope needs a uint32 byte length');
      const size = length(26, end);
      need(size, end);
      if (size < 2 || (buffer[pos] !== 0xbf && buffer[pos] !== 0x9f))
        invalid('envelope must contain a map or array');
      const nestedEnd = pos + size;
      // An envelope is not another level of JSON nesting.
      const result = value(depth, nestedEnd);
      if (pos !== nestedEnd) invalid('envelope length mismatch');
      return result;
    }
    if (token === 0xd6) {
      need(1, end);
      const bytes = buffer[pos++]!;
      if (bytes >> 5 !== 2) invalid('binary tag needs a byte string');
      const size = length(bytes & 31, end);
      need(size, end);
      const result = buffer.toString('base64', pos, pos + size);
      pos += size;
      return result;
    }
    if (token === 0x9f) {
      const result: unknown[] = [];
      while (true) {
        need(1, end);
        const next = buffer[pos]!;
        if (next === 0xff) {
          pos++;
          return result;
        }
        // Snapshot style/node tables contain millions of small indices.
        // Avoid recursive calls for these scalars, retaining bounds checks.
        if (depth === MAX_DEPTH) invalid('nesting exceeds 300');
        if (next < 0x18) {
          pos++;
          result.push(next);
          continue;
        }
        if (next === 0x18) {
          need(2, end);
          result.push(buffer[pos + 1]!);
          pos += 2;
          continue;
        }
        if (next === 0x19) {
          need(3, end);
          result.push(buffer.readUInt16BE(pos + 1));
          pos += 3;
          continue;
        }
        result.push(value(depth + 1, end));
      }
    }
    if (token === 0xbf) {
      const result: Record<string, unknown> = {};
      while (true) {
        need(1, end);
        if (buffer[pos] === 0xff) {
          pos++;
          return result;
        }
        const key = value(depth + 1, end);
        if (typeof key !== 'string') invalid('map key must be a string');
        const item = value(depth + 1, end);
        // JSON.parse creates an own property for __proto__, never a setter call.
        Object.defineProperty(result, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    const major = token >> 5;
    if (major === 0 || major === 1) {
      const n = length(token & 31, end);
      if (n > MAX_INT32) invalid('integer outside int32');
      return major === 0 ? n : -1 - n;
    }
    if (major === 2 || major === 3) {
      const size = length(token & 31, end);
      need(size, end);
      if (major === 2 && size % 2) invalid('odd UTF16 byte length');
      if (major === 3 && !isUtf8(buffer.subarray(pos, pos + size)))
        invalid('invalid UTF8');
      // cbor.h's big-endian comment is wrong: EncodeString16 emits UTF16LE.
      const result = buffer.toString(major === 2 ? 'utf16le' : 'utf8', pos, pos + size);
      pos += size;
      return result;
    }
    if (token === 0xf4) return false;
    if (token === 0xf5) return true;
    if (token === 0xf6) return null;
    if (token === 0xfb) {
      need(8, end);
      const n = buffer.readDoubleBE(pos);
      pos += 8;
      // CRDTP JSONWriter::HandleDouble emits null for non-finite values and
      // casts integral doubles (including -0) to int64 before writing them.
      return Number.isFinite(n) ? (n === 0 ? 0 : n) : null;
    }
    return invalid(`unsupported token 0x${token.toString(16)}`);
  };
  const result = value(0, buffer.length);
  if (pos !== buffer.length) invalid('trailing bytes');
  return result;
}

/** Encode JSON-shaped command values. No arbitrary classes or custom toJSON. */
export function encodeCbor(input: unknown): Buffer {
  const chunks: Buffer[] = [];
  let size = 0;
  const ancestors = new Set<object>();
  const emit = (buffer: Buffer) => {
    size += buffer.length;
    if (size > MAX_LENGTH) invalid('message exceeds uint32 length');
    chunks.push(buffer);
  };
  const header = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    const bytes = n <= 0xff ? 1 : n <= 0xffff ? 2 : 4;
    const result = Buffer.allocUnsafe(bytes + 1);
    result[0] = (major << 5) | (bytes === 1 ? 24 : bytes === 2 ? 25 : 26);
    result.writeUIntBE(n, 1, bytes);
    return result;
  };
  const value = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) invalid('nesting exceeds 300');
    if (v === null) {
      emit(Buffer.from([0xf6]));
      return;
    }
    if (typeof v === 'boolean') {
      emit(Buffer.from([v ? 0xf5 : 0xf4]));
      return;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        emit(Buffer.from([0xf6]));
        return;
      }
      if (Number.isInteger(v) && v >= -2147483648 && v <= MAX_INT32)
        emit(header(v < 0 ? 1 : 0, v < 0 ? -1 - v : v));
      else {
        const result = Buffer.allocUnsafe(9);
        result[0] = 0xfb;
        result.writeDoubleBE(v, 1);
        emit(result);
      }
      return;
    }
    if (typeof v === 'string') {
      let ascii = true;
      for (let i = 0; i < v.length; i++) {
        if (v.charCodeAt(i) > 127) {
          ascii = false;
          break;
        }
      }
      const bytes = Buffer.from(v, ascii ? 'utf8' : 'utf16le');
      emit(header(ascii ? 3 : 2, bytes.length));
      emit(bytes);
      return;
    }
    if (typeof v !== 'object') invalid(`unsupported ${typeof v}`);
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      invalid('unsupported object prototype');
    if (ancestors.has(v)) invalid('cyclic value');
    ancestors.add(v);
    const envelope = Buffer.from([0xd8, 0x18, 0x5a, 0, 0, 0, 0]);
    emit(envelope);
    const start = size;
    emit(Buffer.from([Array.isArray(v) ? 0x9f : 0xbf]));
    if (Array.isArray(v)) {
      for (const item of v) value(item === undefined ? null : item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(v)) {
        if (item === undefined) continue;
        value(key, depth + 1);
        value(item, depth + 1);
      }
    }
    emit(Buffer.from([0xff]));
    envelope.writeUInt32BE(size - start, 3);
    ancestors.delete(v);
  };
  value(input, 0);
  return Buffer.concat(chunks, size);
}

/** Linear framing: copy a fragmented message once, never on every pipe chunk. */
export class CborFramer {
  private readonly header = Buffer.allocUnsafe(7);
  private headerBytes = 0;
  private parts: Buffer[] = [];
  private bytes = 0;
  private expected: number | undefined;
  private failed = false;

  constructor(private readonly maxFrameBytes = Infinity) {
    if (
      maxFrameBytes !== Infinity &&
      (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
    )
      throw new Error('jux: invalid CBOR frame limit');
  }

  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    if (this.failed) invalid('framer already failed');
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (this.expected === undefined) {
          this.header[this.headerBytes++] = chunk[offset++]!;
          this.expected = frameSize(this.header.subarray(0, this.headerBytes));
          if (this.expected === undefined) continue;
          if (this.expected > this.maxFrameBytes) invalid('frame exceeds byte limit');
          this.parts.push(Buffer.from(this.header.subarray(0, this.headerBytes)));
          this.bytes = this.headerBytes;
        }
        const count = Math.min(chunk.length - offset, this.expected - this.bytes);
        if (count) {
          this.parts.push(chunk.subarray(offset, offset + count));
          this.bytes += count;
          offset += count;
        }
        if (this.bytes === this.expected) {
          const frame = Buffer.concat(this.parts, this.bytes);
          if (frame[this.headerBytes] !== 0xbf) invalid('top-level frame must be a map');
          this.parts = [];
          this.bytes = 0;
          this.headerBytes = 0;
          this.expected = undefined;
          onFrame(frame);
        }
      }
    } catch (error) {
      this.failed = true;
      this.parts = [];
      throw error;
    }
  }
}
