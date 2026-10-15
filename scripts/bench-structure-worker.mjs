#!/usr/bin/env node
// Offline only: build core first, then pass raw CDP JSON files or {raw, viewport}
// fixtures. Example: node scripts/bench-structure-worker.mjs --iterations 100 file.json
// This measures worker overhead, not screenshot overlap or end-to-end capture speed.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { normalizeStructure } from '../packages/core/dist/capture/structure.js';

if (!isMainThread) {
  parentPort.on('message', ({ raw, viewport, mode }) => {
    try {
      const start = performance.now();
      const snapshot =
        mode === 'normalize' ? normalizeStructure(raw, viewport) : undefined;
      const computeMs = performance.now() - start;
      parentPort.postMessage({ snapshot, computeMs });
    } catch (error) {
      parentPort.postMessage({ error: String(error) });
    }
  });
  parentPort.postMessage({ ready: true });
} else {
  const args = process.argv.slice(2);
  const files = [];
  let iterations = 100;
  let viewport = { width: 1280, height: 800 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations') iterations = Number(args[++i]);
    else if (args[i] === '--viewport') {
      const match = /^(\d+)x(\d+)$/.exec(args[++i] ?? '');
      if (!match) throw new Error('--viewport requires WIDTHxHEIGHT');
      viewport = { width: Number(match[1]), height: Number(match[2]) };
    } else if (args[i].startsWith('-')) throw new Error(`Unknown option: ${args[i]}`);
    else files.push(resolve(args[i]));
  }
  if (!Number.isInteger(iterations) || iterations < 5 || iterations > 1000)
    throw new Error('--iterations must be an integer from 5 to 1000');
  if (!files.length)
    files.push(
      resolve(
        import.meta.dirname,
        '../packages/core/src/capture/__fixtures__/structure-basic.cdp.json',
      ),
    );
  if (files.length > 20) throw new Error('At most 20 input files per benchmark');

  const workerStart = performance.now();
  const worker = new Worker(new URL(import.meta.url));
  // Exactly one outstanding request: no unbounded queue or simultaneous snapshots.
  const receive = () =>
    new Promise((resolveMessage, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Worker response timed out')),
        30_000,
      );
      const onMessage = (message) => finish(undefined, message);
      const onError = (error) => finish(error);
      const onExit = (code) => finish(new Error(`Worker exited: ${code}`));
      const finish = (error, message) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (error) reject(error);
        else resolveMessage(message);
      };
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
  const roundtrip = async (raw, viewport, mode) => {
    const response = receive();
    const start = performance.now();
    worker.postMessage({ raw, viewport, mode });
    const postMs = performance.now() - start;
    const result = await response;
    const totalMs = performance.now() - start;
    if (result.error) throw new Error(result.error);
    return { ...result, totalMs, postMs };
  };
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
    return { median: percentile(0.5), p95: percentile(0.95) };
  };
  const results = [];
  try {
    await receive();
    const startupMs = performance.now() - workerStart;
    for (const file of files) {
      if (statSync(file).size > 64 * 1024 * 1024)
        throw new Error(`Input exceeds 64 MiB: ${file}`);
      const input = JSON.parse(readFileSync(file, 'utf8'));
      const raw = input.raw ?? input;
      const dimensions = input.viewport ?? viewport;
      if (!Array.isArray(raw.documents) || !Array.isArray(raw.strings))
        throw new Error(`Not a DOMSnapshot response: ${file}`);
      if (
        ![dimensions.width, dimensions.height].every((n) => Number.isInteger(n) && n > 0)
      )
        throw new Error(`Invalid viewport: ${file}`);
      const reference = normalizeStructure(raw, dimensions);
      const referenceJson = JSON.stringify(reference);
      const verify = (snapshot) => {
        if (
          snapshot.structureHash !== reference.structureHash ||
          JSON.stringify(snapshot) !== referenceJson
        )
          throw new Error(`Exact normalized JSON/hash mismatch: ${file}`);
      };
      const direct = [],
        workerTotal = [],
        workerCompute = [],
        post = [],
        overhead = [],
        cloneAck = [];
      for (let pass = -5; pass < iterations; pass++) {
        // Alternate order to reduce consistent warm-cache/order bias; exclude five warm-ups.
        const runDirect = () => {
          const start = performance.now();
          const snapshot = normalizeStructure(raw, dimensions);
          const elapsed = performance.now() - start;
          verify(snapshot);
          if (pass >= 0) direct.push(elapsed);
        };
        const runWorker = async () => {
          const result = await roundtrip(raw, dimensions, 'normalize');
          verify(result.snapshot);
          if (pass >= 0) {
            workerTotal.push(result.totalMs);
            workerCompute.push(result.computeMs);
            post.push(result.postMs);
            overhead.push(result.totalMs - result.computeMs);
          }
        };
        if (pass % 2 === 0) {
          runDirect();
          await runWorker();
        } else {
          await runWorker();
          runDirect();
        }
        // Same inbound object, tiny acknowledgement: estimates input cloning + scheduling,
        // not a pure clone timer. Normalization roundtrip also clones its result back.
        const ack = await roundtrip(raw, dimensions, 'ack');
        if (pass >= 0) cloneAck.push(ack.totalMs);
      }
      results.push({
        file,
        viewport: dimensions,
        iterations,
        payloadBytes: Buffer.byteLength(JSON.stringify(raw)),
        resultBytes: Buffer.byteLength(referenceJson),
        nodes: raw.documents[0]?.nodes?.nodeType?.length,
        elements: reference.elements.length,
        structureHash: reference.structureHash,
        exactParity: true,
        ms: {
          direct: stats(direct),
          workerRoundtrip: stats(workerTotal),
          workerCompute: stats(workerCompute),
          postMessage: stats(post),
          roundtripMinusCompute: stats(overhead),
          inputCloneAndAck: stats(cloneAck),
        },
      });
    }
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          workerStartupMs: Number(startupMs.toFixed(3)),
          warmups: 5,
          note: 'Serial offline CPU/IPC benchmark; no Chrome, screenshot overlap, or capture-speed claim. Uses the current core dist build.',
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await worker.terminate();
  }
}
