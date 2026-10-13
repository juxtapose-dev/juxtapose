// Minimal zip writer for tests: local headers + central directory + EOCD,
// deflate or stored, unix mode in the external attributes, no zip64.
import { deflateRawSync, crc32 } from 'node:zlib';

export interface ZipSpec {
  name: string;
  data: Buffer;
  mode: number;
  stored?: boolean;
  symlink?: boolean;
  /** Lie about the uncompressed size in the headers (zip-bomb tests). */
  claimedSize?: number;
}

export function buildZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name);
    const body = s.stored ? s.data : deflateRawSync(s.data);
    const method = s.stored ? 0 : 8;
    const crc = crc32(s.data);
    const usize = s.claimedSize ?? s.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28);
    const type = s.symlink ? 0o120000 : s.name.endsWith('/') ? 0o040000 : 0o100000;
    central.writeUInt32LE(((type | s.mode) >>> 0) * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
