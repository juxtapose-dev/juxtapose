// Diagnostic prototype: run's artifact consumer submits one sidecar at a time.
import { Worker } from 'node:worker_threads';
import type { StructureSnapshot } from '@juxtapose/core';
let worker: Worker | undefined;
let busy = false;
export function encodeStructureAsync(structure: StructureSnapshot): Promise<Buffer> {
  if (busy) return Promise.reject(new Error('Concurrent encoding request'));
  busy = true;
  const current = (worker ??= new Worker(
    new URL('./structure-encoding-worker.js', import.meta.url),
  ));
  current.ref();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      busy = false;
      current.off('message', received);
      current.off('error', failed);
      current.off('exit', exited);
      current.unref();
    };
    const failed = (error: Error) => {
      cleanup();
      worker = undefined;
      reject(error);
    };
    const exited = (code: number) => failed(new Error(`Encoding worker exited: ${code}`));
    const received = (message: { encoded?: Uint8Array; error?: string }) => {
      cleanup();
      if (message.encoded) resolve(Buffer.from(message.encoded));
      else reject(new Error(message.error ?? 'Missing encoded structure'));
    };
    current.once('message', received);
    current.once('error', failed);
    current.once('exit', exited);
    try {
      current.postMessage(structure);
    } catch (error) {
      failed(error as Error);
    }
  });
}
