#!/usr/bin/env node
// A stand-in for Chrome in lifecycle tests: speaks selected JSON/binary CDP on fd 3 (in)
// and fd 4 (out), answers every command with `{}`, and runs until killed.
// Modes via JUX_FAKE_CHROME: "hang" never answers; "ignore-term" ignores SIGTERM.
import { createReadStream, createWriteStream } from 'node:fs';
import { CborFramer, encodeCbor, decodeCbor } from '../../../dist/browser/cbor.js';
const binary = process.argv.includes('--remote-debugging-pipe=cbor');
const framer = new CborFramer();
const mode = process.env.JUX_FAKE_CHROME ?? '';
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const input = createReadStream(null, { fd: 3 });
const output = createWriteStream(null, { fd: 4 });
let buf = '';
input.on('data', (d) => {
  if (mode === 'hang') return;
  if (binary) {
    framer.push(d, (frame) =>
      output.write(encodeCbor({ id: decodeCbor(frame).id, result: {} })),
    );
    return;
  }
  buf += d.toString();
  const parts = buf.split('\0');
  buf = parts.pop();
  if (mode === 'hang') return;
  for (const raw of parts)
    output.write(JSON.stringify({ id: JSON.parse(raw).id, result: {} }) + '\0');
});
input.on('close', () => process.exit(0));
setInterval(() => {}, 1 << 30);
