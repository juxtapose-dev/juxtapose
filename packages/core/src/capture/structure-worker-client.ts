// Diagnostic prototype: one shared CPU worker, bounded by in-flight captures.
import { Worker } from 'node:worker_threads';
import type { normalizeStructure } from './structure.js';
import type { StructureSnapshot } from '../types.js';

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (value: StructureSnapshot | undefined) => void>();

export function normalizeInWorker(
  raw: Parameters<typeof normalizeStructure>[0],
  viewport: Parameters<typeof normalizeStructure>[1],
): Promise<StructureSnapshot | undefined> {
  if (!worker) {
    const current = new Worker(new URL('./structure-worker.js', import.meta.url));
    worker = current;
    current.on(
      'message',
      ({ id, structure }: { id: number; structure?: StructureSnapshot }) => {
        pending.get(id)?.(structure);
        pending.delete(id);
        if (!pending.size) current.unref();
      },
    );
    const failed = () => {
      if (worker !== current) return;
      worker = undefined;
      for (const resolve of pending.values()) resolve(undefined);
      pending.clear();
    };
    current.on('error', failed);
    current.on('exit', failed);
    current.unref();
  }
  const current = worker;
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    current.ref();
    try {
      current.postMessage({ id, raw, viewport });
    } catch {
      pending.delete(id);
      if (!pending.size) current.unref();
      resolve(undefined);
    }
  });
}
