import { parentPort } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import type { StructureSnapshot } from '@juxtapose/core';
parentPort!.on('message', (structure: StructureSnapshot) => {
  try {
    const encoded = gzipSync(Buffer.from(JSON.stringify(structure)));
    parentPort!.postMessage({ encoded });
  } catch (error) {
    parentPort!.postMessage({ error: String(error) });
  }
});
