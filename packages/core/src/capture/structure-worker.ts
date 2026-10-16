import { parentPort } from 'node:worker_threads';
import { normalizeStructure } from './structure.js';

parentPort!.on(
  'message',
  ({
    id,
    raw,
    viewport,
  }: {
    id: number;
    raw: Parameters<typeof normalizeStructure>[0];
    viewport: Parameters<typeof normalizeStructure>[1];
  }) => {
    try {
      parentPort!.postMessage({ id, structure: normalizeStructure(raw, viewport) });
    } catch {
      parentPort!.postMessage({ id, structure: undefined });
    }
  },
);
