import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  decodeStructure,
  extractTargetEvidence,
  matchTargetLayout,
  type TargetEvidence,
  type TargetLayoutResult,
} from '@juxtapose/core';
import { isRecord } from '../guards.js';

// Change the directory version when segmentation, matching or evidence meaning
// changes. The 39-pair feasibility study does not justify default MCP output.
const VERSION = 2;
const MAX_ENTRIES = 16;
const MAX_BYTES = 1024 * 1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

type Match = TargetLayoutResult['matches'][number];
export type ReferenceLayoutDetail = Omit<TargetLayoutResult, 'matches'> & {
  confidenceRules: Record<string, string>;
  matches: Array<
    Omit<Match, 'element' | 'targetBlock' | 'currentBlock'> & {
      element: Omit<Match['element'], 'path'> & { path?: string };
    }
  >;
  omittedMatches: number;
};

/** One MCP session reuses small derived evidence, never full decoded frames.
 * On restart the content-addressed disk cache serves identical requests. */
export class ReferenceLayoutCache {
  private readonly images = new Map<string, Promise<TargetEvidence>>();
  private readonly pairs = new Map<string, Promise<TargetLayoutResult>>();

  async evaluate(input: {
    project: string;
    reference: Buffer;
    current: Buffer;
    structure: Buffer;
    referenceHash: string;
    currentHash: string;
  }): Promise<ReferenceLayoutDetail> {
    const referenceHash = hash(input.reference),
      currentHash = hash(input.current);
    if (referenceHash !== input.referenceHash || currentHash !== input.currentHash)
      throw new Error('saved reference or capture changed during analysis');
    const project = await realpath(input.project);
    const key = hash(
      JSON.stringify([VERSION, referenceHash, currentHash, hash(input.structure)]),
    );
    const result = await memo(this.pairs, `${project}:${key}`, async () => {
      const cache = await cacheDirectory(project);
      return derived(cache, `pair-${key}`, isLayout, async () => {
        const evidence = (image: Buffer, imageHash: string) =>
          memo(this.images, `${project}:${imageHash}`, () =>
            derived(cache, `image-${imageHash}`, isEvidence, () =>
              extractTargetEvidence(image),
            ),
          );
        const [target, current] = await Promise.all([
          evidence(input.reference, referenceHash),
          evidence(input.current, currentHash),
        ]);
        return matchTargetLayout(target, current, decodeStructure(input.structure));
      });
    });
    const confidenceRules: Record<string, string> = {};
    const ruleIds = new Map<string, string>();
    const matches = result.matches.slice(0, 8).map((match) => {
      let rule = ruleIds.get(match.confidenceRule);
      if (!rule) {
        rule = `paint-${ruleIds.size + 1}`;
        ruleIds.set(match.confidenceRule, rule);
        confidenceRules[rule] = match.confidenceRule;
      }
      const { element, targetBox, currentBox, dx, dy, dw, dh, provenance } = match;
      return {
        element: {
          label: element.label,
          ...(element.id ? { id: element.id } : { path: element.path }),
          provenance: element.provenance,
        },
        targetBox,
        currentBox,
        dx,
        dy,
        dw,
        dh,
        provenance,
        confidenceRule: rule,
      };
    });
    return {
      ...result,
      confidenceRules,
      matches,
      omittedMatches: Math.max(0, result.matches.length - 8),
    };
  }
}

function memo<T>(
  entries: Map<string, Promise<T>>,
  key: string,
  produce: () => Promise<T>,
): Promise<T> {
  let result = entries.get(key);
  if (result) {
    entries.delete(key);
    entries.set(key, result);
    return result;
  }
  result = produce();
  entries.set(key, result);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  const pending = result;
  void result.catch(() => {
    if (entries.get(key) === pending) entries.delete(key);
  });
  return result;
}

/** Create/check one component at a time: recursive mkdir through a symlink
 * could write outside the project before a later containment check noticed. */
async function cacheDirectory(project: string): Promise<string | null> {
  let dir = project;
  try {
    for (const part of ['.juxtapose', 'analysis', `target-layout-v${VERSION}`]) {
      dir = path.join(dir, part);
      try {
        await mkdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      }
      if (!(await lstat(dir)).isDirectory() || (await realpath(dir)) !== dir) return null;
    }
    return dir;
  } catch {
    return null;
  }
}

async function derived<T extends object>(
  dir: string | null,
  key: string,
  valid: (value: unknown) => value is T,
  produce: () => Promise<T>,
): Promise<T> {
  const file = dir ? path.join(dir, `${key}.json`) : null;
  if (file) {
    try {
      const info = await lstat(file);
      if (info.isFile() && info.size <= MAX_BYTES) {
        const entry: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (
          isRecord(entry) &&
          entry['version'] === VERSION &&
          entry['key'] === key &&
          valid(entry['data']) &&
          entry['checksum'] === hash(JSON.stringify(entry['data']))
        )
          return entry['data'];
      }
    } catch {
      /* absent or corrupt derived cache: recompute */
    }
  }
  const data = await produce();
  if (file) {
    const text = JSON.stringify({
      version: VERSION,
      key,
      data,
      checksum: hash(JSON.stringify(data)),
    });
    const temporary = `${file}.${randomUUID()}.tmp`;
    if (Buffer.byteLength(text) <= MAX_BYTES) {
      try {
        await writeFile(temporary, text, { flag: 'wx' });
        await rename(temporary, file);
      } catch {
        /* read-only caches cannot change evidence or verdicts */
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
  }
  return data;
}

function isEvidence(value: unknown): value is TargetEvidence {
  return (
    isRecord(value) &&
    value['schema'] === 'juxtapose.target-evidence/v1' &&
    Number.isInteger(value['width']) &&
    Number.isInteger(value['height']) &&
    Array.isArray(value['blocks']) &&
    value['blocks'].length <= 256 &&
    isRecord(value['abstained'])
  );
}
function isLayout(value: unknown): value is TargetLayoutResult {
  return (
    isRecord(value) &&
    (value['status'] === 'measured' || value['status'] === 'abstained') &&
    Array.isArray(value['matches']) &&
    value['matches'].length <= 256 &&
    typeof value['abstained'] === 'number'
  );
}
