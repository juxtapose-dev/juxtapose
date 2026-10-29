import { open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import {
  buildHostedDomEvidence,
  encodeStoryId,
  type StructureSnapshot,
} from '@juxtapose/core';

const FILE_LIMIT = 1024 * 1024;
const INFLATE_LIMIT = 8 * 1024 * 1024;
export const HOSTED_REPORT_LIMIT = 5 * 1024 * 1024;
/** Bound both compressed input and decompression before parsing baseline or current evidence. */
interface BoundStructure extends StructureSnapshot {
  captureIdentity?: { storyId?: unknown; imageHash?: unknown; structureHash?: unknown };
}
export function decodeHostedStructure(bytes: Buffer): BoundStructure | undefined {
  try {
    if (bytes.length > FILE_LIMIT) return;
    const plain =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? gunzipSync(bytes, { maxOutputLength: INFLATE_LIMIT })
        : bytes;
    return JSON.parse(plain.toString('utf8')) as BoundStructure;
  } catch {
    return;
  }
}
/** Optional diagnostics: reject oversized, legacy or mismatched sidecars without affecting pixels. */
export async function readHostedStructure(
  file: string,
  storyId: string,
  imageHash: string,
): Promise<StructureSnapshot | undefined> {
  let handle;
  try {
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) return;
    const bytes = Buffer.alloc(FILE_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > FILE_LIMIT) return;
    const compressed = bytes.subarray(0, length);
    const data = decodeHostedStructure(compressed);
    if (!data) return;
    if (
      data.captureIdentity?.storyId !== storyId ||
      data.captureIdentity.imageHash !== imageHash ||
      data.captureIdentity.structureHash !== data.structureHash
    )
      return;
    return data;
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => {});
  }
}
interface SnapshotIdentity {
  result: { storyId: string; status: string };
  contentHash: string;
  baselineHash?: string;
}
/** Fairly share the final report's remaining wire budget; DOM is never required for upload. */
export async function attachHostedDom<
  T extends {
    sourceReport: { results: Array<{ storyId: string; domEvidence?: unknown }> };
  },
>(report: T, runDir: string, snapshots: SnapshotIdentity[]): Promise<T> {
  const results: Array<{ storyId: string; domEvidence?: unknown }> =
    report.sourceReport.results.map(({ domEvidence: _unverified, ...result }) => result);
  const output = { ...report, sourceReport: { ...report.sourceReport, results } };
  let remaining = HOSTED_REPORT_LIMIT - Buffer.byteLength(JSON.stringify(output));
  const eligible = snapshots.filter((s) => s.result.status !== 'skip' && s.baselineHash);
  for (const [index, snapshot] of eligible.entries()) {
    const allowance = Math.min(
      64 * 1024,
      Math.floor(remaining / (eligible.length - index)) - 32,
    );
    if (allowance < 1024) continue;
    const row = results.find((r) => r.storyId === snapshot.result.storyId);
    if (!row) continue;
    const safe = encodeStoryId(snapshot.result.storyId);
    const [baseline, current] = await Promise.all([
      readHostedStructure(
        path.join(runDir, 'images', `${safe}-baseline.structure.json.gz`),
        snapshot.result.storyId,
        snapshot.baselineHash!,
      ),
      readHostedStructure(
        path.join(runDir, 'images', `${safe}-current.structure.json.gz`),
        snapshot.result.storyId,
        snapshot.contentHash,
      ),
    ]);
    if (!baseline || !current) continue;
    const domEvidence = buildHostedDomEvidence(baseline, current, allowance);
    if (!domEvidence) continue;
    Object.assign(row, { hash: snapshot.contentHash, domEvidence });
    remaining -=
      Buffer.byteLength(JSON.stringify({ domEvidence, hash: snapshot.contentHash })) - 1;
  }
  // Protect callers from optional metadata growth, including UTF-8 and wrapper overhead.
  if (Buffer.byteLength(JSON.stringify(output)) > HOSTED_REPORT_LIMIT) {
    return {
      ...report,
      sourceReport: {
        ...report.sourceReport,
        results: results.map(({ domEvidence: _ignored, ...row }) => row),
      },
    };
  }
  return output;
}
