import {
  fitsFocusedEvidence,
  evidenceBytes,
  FOCUSED_TARGET_BYTES,
  FOCUSED_MAX_BYTES,
} from './reference-evidence-budget.js';
import { createHash } from 'node:crypto';
import type {
  PaintComponentEvidence,
  RgbaImage,
  StructureSnapshot,
  TargetEvidence,
} from '@juxtapose/core';
import { isRecord } from '../guards.js';
import { derived } from './reference-derived-cache.js';

export interface TargetTextProvider {
  /** Fingerprint engine, language data, preprocessing and recognition settings. */
  cacheKey: string;
  recognize(input: {
    rgba: Buffer;
    width: number;
    height: number;
    fill: [number, number, number];
  }): Promise<unknown>;
}
export interface PaintRegion {
  id: string;
  box: { x: number; y: number; width: number; height: number };
  fill: [number, number, number];
  solidArea: number;
  cropHash: string;
  /** Full cached region text; compact projection is separate. */
  text?: { full: string; score: number };
  elementText?: string;
  textStatus?: 'observed' | 'low-score' | 'provider-error';
}
export interface PaintImageEvidence {
  status: 'measured';
  frameHash: string;
  width: number;
  height: number;
  regions: PaintRegion[];
  omittedComponents: number;
  abstainedComponents: number;
  providerFailures: number;
}
export interface PaintUnavailable {
  status: 'unavailable';
  reason: string;
}
export interface ObservedImage {
  layout: TargetEvidence;
  paint?: PaintImageEvidence | PaintUnavailable;
}
export interface ReferencePaintDetail {
  target: PaintImageEvidence | PaintUnavailable;
  current: PaintImageEvidence | PaintUnavailable;
}
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const MAX_REGIONS = 8,
  MAX_TEXT = 16384;
const finiteInt = (v: unknown, min = 0): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min;
const rgb = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => finiteInt(n) && n <= 255);
function isText(value: unknown): value is { full: string; score: number } {
  return (
    isRecord(value) &&
    typeof value.full === 'string' &&
    value.full.length <= MAX_TEXT &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 100
  );
}
export function isPaint(value: unknown): value is PaintImageEvidence {
  if (
    !isRecord(value) ||
    value.status !== 'measured' ||
    typeof value.frameHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.frameHash) ||
    !finiteInt(value.width, 1) ||
    !finiteInt(value.height, 1) ||
    !finiteInt(value.omittedComponents) ||
    !finiteInt(value.abstainedComponents) ||
    !finiteInt(value.providerFailures) ||
    !Array.isArray(value.regions) ||
    value.regions.length > MAX_REGIONS
  )
    return false;
  const width = value.width,
    height = value.height;
  if (
    value.providerFailures !==
    value.regions.filter((r) => isRecord(r) && r.textStatus === 'provider-error').length
  )
    return false;
  return value.regions.every(
    (r) =>
      isRecord(r) &&
      typeof r.id === 'string' &&
      typeof r.cropHash === 'string' &&
      /^[a-f0-9]{64}$/.test(r.cropHash) &&
      /^paint:[a-f0-9]{64}$/.test(r.id) &&
      isRecord(r.box) &&
      finiteInt(r.box.x, 1) &&
      finiteInt(r.box.y, 1) &&
      finiteInt(r.box.width, 1) &&
      finiteInt(r.box.height, 1) &&
      r.box.x + r.box.width < width &&
      r.box.y + r.box.height < height &&
      rgb(r.fill) &&
      finiteInt(r.solidArea, 16) &&
      r.solidArea <= r.box.width * r.box.height &&
      r.elementText === undefined &&
      (r.text === undefined || isText(r.text)) &&
      (r.textStatus === undefined
        ? r.text === undefined
        : r.textStatus === 'provider-error'
          ? r.text === undefined
          : isText(r.text) &&
            (r.textStatus === 'observed'
              ? r.text.score >= 90 && Boolean(r.text.full.trim())
              : r.textStatus === 'low-score' &&
                (r.text.score < 90 || !r.text.full.trim()))),
  );
}

/** The successful prototype needed exact component color, while clipped Mana
 * scored94. Only full-image component crops are submitted; never arbitrary ROIs.
 * Two concurrent provider calls and eight bounded crops limit cold-path work. */
export class ReferencePaintAnalyzer {
  private readonly text = new Map<string, Promise<{ full: string; score: number }>>();
  private readonly pending = new Set<string>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly provider: TargetTextProvider) {
    if (
      typeof provider.cacheKey !== 'string' ||
      !provider.cacheKey.trim() ||
      provider.cacheKey.length > 4096
    )
      throw new Error('experimental text provider requires a versioned cacheKey');
  }
  private limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.waiting.length >= 64)
      return Promise.reject(new Error('text provider queue is full'));
    return new Promise<T>((resolve, reject) => {
      // A stalled optional provider must not hide geometry. Timed-out active
      // work retains its real slot until settlement; retries cannot oversubscribe.
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error('text provider deadline exceeded'));
      }, 2000);
      const start = () => {
        this.active++;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timer);
            this.active--;
            this.waiting.shift()?.();
          });
      };
      if (this.active < 2) start();
      else this.waiting.push(start);
    });
  }
  private textResult(
    key: string,
    produce: () => Promise<{ full: string; score: number }>,
  ) {
    const hit = this.text.get(key);
    if (hit) {
      this.text.delete(key);
      this.text.set(key, hit);
      return hit;
    }
    const result = produce();
    this.text.set(key, result);
    this.pending.add(key);
    void result.then(
      () => {
        this.pending.delete(key);
        for (const candidate of this.text.keys()) {
          if (this.text.size <= 16) break;
          if (!this.pending.has(candidate)) this.text.delete(candidate);
        }
      },
      () => {
        this.pending.delete(key);
        if (this.text.get(key) === result) this.text.delete(key);
      },
    );
    return result;
  }
  async observe(
    image: RgbaImage,
    evidence: PaintComponentEvidence,
    frameHash: string,
    role: 'target' | 'current',
    cache: string | null,
  ): Promise<PaintImageEvidence | PaintUnavailable> {
    if (evidence.complexity)
      return { status: 'unavailable', reason: 'component-complexity-limit' };
    const eligible = evidence.components
      .filter(
        (c) =>
          c.box.width <= 256 &&
          c.box.height <= 128 &&
          c.box.x > 0 &&
          c.box.y > 0 &&
          c.box.x + c.box.width < image.width &&
          c.box.y + c.box.height < image.height,
      )
      .sort(
        (a, b) =>
          Number(a.fill.every((n) => n === 255)) -
            Number(b.fill.every((n) => n === 255)) ||
          b.solidArea - a.solidArea ||
          a.box.y - b.box.y ||
          a.box.x - b.box.x,
      );
    let providerFailures = 0;
    const regions = await Promise.all(
      eligible.slice(0, MAX_REGIONS).map(async (c) => {
        const region: PaintRegion = {
          id: `paint:${hash(JSON.stringify([frameHash, c.box, c.fill, c.seed]))}`,
          box: c.box,
          fill: c.fill,
          solidArea: c.solidArea,
          cropHash: '',
        };
        const { box } = c,
          rgba = Buffer.alloc(box.width * box.height * 4);
        for (let y = 0; y < box.height; y++)
          rgba.set(
            image.data.subarray(
              ((box.y + y) * image.width + box.x) * 4,
              ((box.y + y) * image.width + box.x + box.width) * 4,
            ),
            y * box.width * 4,
          );
        region.cropHash = hash(
          Buffer.concat([Buffer.from(JSON.stringify([box.width, box.height])), rgba]),
        );
        if (role === 'current') return region;
        const key = hash(
          Buffer.concat([
            Buffer.from(
              JSON.stringify([
                'paint-text-v1',
                this.provider.cacheKey,
                box.width,
                box.height,
                c.fill,
              ]),
            ),
            rgba,
          ]),
        );
        try {
          region.text = await this.textResult(key, () =>
            derived(cache, `paint-text-${key}`, isText, () =>
              this.limited(async () => {
                const value = await this.provider.recognize({
                  rgba,
                  width: box.width,
                  height: box.height,
                  fill: c.fill,
                });
                if (!isRecord(value) || !isText({ full: value.text, score: value.score }))
                  throw new Error('invalid text provider result');
                return { full: value.text as string, score: value.score as number };
              }),
            ),
          );
          region.textStatus =
            region.text.score >= 90 && region.text.full.trim() ? 'observed' : 'low-score';
        } catch {
          providerFailures++;
          region.textStatus = 'provider-error';
        }
        return region;
      }),
    );
    return {
      status: 'measured',
      frameHash,
      width: image.width,
      height: image.height,
      regions,
      omittedComponents:
        evidence.omittedComponents + Math.max(0, eligible.length - MAX_REGIONS),
      abstainedComponents: evidence.components.length - eligible.length,
      providerFailures,
    };
  }
}

export function currentElementText(
  paint: PaintImageEvidence | PaintUnavailable,
  structure: StructureSnapshot,
): PaintImageEvidence | PaintUnavailable {
  if (
    paint.status !== 'measured' ||
    structure.truncated ||
    paint.width !== structure.viewport.width ||
    paint.height !== structure.viewport.height
  )
    return paint;
  return {
    ...paint,
    regions: paint.regions.map((r) => {
      const matches = structure.elements.filter(
        (e) =>
          e.text &&
          Math.max(
            Math.abs(e.rect.x - r.box.x),
            Math.abs(e.rect.y - r.box.y),
            Math.abs(e.rect.x + e.rect.w - r.box.x - r.box.width),
            Math.abs(e.rect.y + e.rect.h - r.box.y - r.box.height),
          ) <= 2,
      );
      return matches.length === 1 ? { ...r, elementText: matches[0]!.text } : r;
    }),
  };
}

export interface CompactPaintRegion {
  box: [x: number, y: number, width: number, height: number];
  rgb: string;
  count: number;
  /** At most three independently observed positions, in y/x order. */
  boxes?: Array<[number, number, number, number]>;
  omittedBoxes?: number;
  textInside?: string;
  score?: number;
  elementText?: string;
}
export interface FocusedPaintFeedback {
  meaning?: string;
  target: CompactPaintRegion[];
  current: CompactPaintRegion[];
  omitted: [target: number, current: number];
  providerFailures?: number;
  unavailable?: Array<'target' | 'current'>;
}

/** Response-size savings alone failed the agent-value gate. Preserve geometry,
 * include short exact color/text facts when they fit, and retain full cached text
 * for explicit JSON reads instead of rerunning recognition or truncating labels. */
export function appendFocusedPaint<
  T extends {
    next: string;
    cropRegion?: { x: number; y: number; width: number; height: number };
    layout?: {
      matches?: Array<{
        targetBox: PaintRegion['box'];
        currentBox: PaintRegion['box'];
        paintedFill: { rgb: [number, number, number] };
      }>;
    };
  },
>(packet: T, paint?: ReferencePaintDetail): T & { paint?: FocusedPaintFeedback } {
  if (!paint) return packet;
  const groups = (
    image: PaintImageEvidence | PaintUnavailable,
    role: 'target' | 'current',
  ) => {
    const found = new Map<string, CompactPaintRegion>();
    const changed = new Map<CompactPaintRegion, boolean>();
    if (image.status !== 'measured') return [];
    const other = paint[role === 'target' ? 'current' : 'target'];
    const counts = (regions: PaintRegion[]) => {
      const result = new Map<string, number>();
      for (const region of regions)
        result.set(region.cropHash, (result.get(region.cropHash) ?? 0) + 1);
      return result;
    };
    const ownCrops = counts(image.regions);
    const oppositeCrops = counts(other.status === 'measured' ? other.regions : []);
    for (const r of image.regions) {
      // A translated component can still explain unresolved geometry. Suppress
      // only equal positioned inventories; prioritize changed pixels below.
      const positioned = (regions: PaintRegion[]) =>
        regions.filter(
          (otherRegion) =>
            otherRegion.cropHash === r.cropHash &&
            otherRegion.box.x === r.box.x &&
            otherRegion.box.y === r.box.y,
        ).length;
      if (
        other.status === 'measured' &&
        positioned(other.regions) === positioned(image.regions)
      )
        continue;
      if (
        packet.layout?.matches?.some((m) => {
          const b = role === 'target' ? m.targetBox : m.currentBox;
          return (
            b.x === r.box.x &&
            b.y === r.box.y &&
            b.width === r.box.width &&
            b.height === r.box.height &&
            m.paintedFill.rgb.every((n, i) => n === r.fill[i])
          );
        })
      )
        continue;
      const text =
        role === 'target'
          ? r.textStatus === 'observed'
            ? r.text?.full
            : undefined
          : r.elementText;
      const value = text?.trim().replace(/\s+/g, ' ');
      if (!value || [...value].length > 40) continue;
      const key = JSON.stringify([value, r.fill, r.box.width, r.box.height]);
      const previous = found.get(key);
      if (previous) {
        previous.count++;
        previous.boxes ??= [[...previous.box]];
        previous.boxes.push([r.box.x, r.box.y, r.box.width, r.box.height]);
        if (role === 'target') previous.score = Math.min(previous.score!, r.text!.score);
        continue;
      }
      const group: CompactPaintRegion = {
        box: [r.box.x, r.box.y, r.box.width, r.box.height],
        rgb: '#' + r.fill.map((n) => n.toString(16).padStart(2, '0')).join(''),
        count: 1,
        ...(role === 'target'
          ? { textInside: value, score: r.text!.score }
          : { elementText: value }),
      };
      found.set(key, group);
      changed.set(group, oppositeCrops.get(r.cropHash) !== ownCrops.get(r.cropHash));
    }
    const area = packet.cropRegion;
    const near = (r: CompactPaintRegion) =>
      area &&
      r.box[0] < area.x + area.width &&
      r.box[0] + r.box[2] > area.x &&
      r.box[1] < area.y + area.height &&
      r.box[1] + r.box[3] > area.y
        ? 0
        : 1;
    // A single representative hid the desktop Manage spacing in the team
    // trace (target y251/333/415 versus current y237/307/377). Keep bounded
    // positions without inventing correspondence or a CSS row-height cause.
    for (const group of found.values()) {
      if (!group.boxes) continue;
      group.boxes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      group.box = [...group.boxes[0]!];
      group.omittedBoxes = Math.max(0, group.boxes.length - 3);
      group.boxes = group.boxes.slice(0, 3);
    }
    return [...found.values()].sort(
      (a, b) =>
        Number(changed.get(b)) - Number(changed.get(a)) ||
        near(a) - near(b) ||
        a.box[1] - b.box[1] ||
        a.box[0] - b.box[0],
    );
  };
  const candidates = [groups(paint.target, 'target'), groups(paint.current, 'current')];
  const total = (v: PaintImageEvidence | PaintUnavailable) =>
    v.status === 'measured'
      ? v.regions.length + v.omittedComponents + v.abstainedComponents
      : 0;
  const detail: FocusedPaintFeedback = {
    meaning:
      'Independent components; box/boxes=[x,y,width,height], not CSS; up to 3 sorted boxes, omittedBoxes counts the rest. textInside=OCR(score not probability); elementText=current DOM. No target/current identity. Full cached text: reference(name,detail=json).',
    target: [],
    current: [],
    omitted: [total(paint.target), total(paint.current)],
  };
  const failures =
    (paint.target.status === 'measured' ? paint.target.providerFailures : 0) +
    (paint.current.status === 'measured' ? paint.current.providerFailures : 0);
  if (failures) detail.providerFailures = failures;
  const unavailable = (['target', 'current'] as const).filter(
    (role) => paint[role].status === 'unavailable',
  );
  if (unavailable.length) detail.unavailable = unavailable;
  if (!candidates.some((side) => side.length) && !failures && !unavailable.length)
    return packet;
  let result = { ...packet, paint: detail };
  if (evidenceBytes(result) > FOCUSED_TARGET_BYTES)
    result = {
      ...result,
      next: 'Propose source-grounded edits; verify affected states. CSS causes are hypotheses. Crop covers cropRegion only. JSON provides all saved matches/full text; other omissions can remain. No PNG target DOM or abstained matches.',
    };
  if (evidenceBytes(result) > FOCUSED_MAX_BYTES) return packet;
  let anchor: T | typeof result = packet;
  for (let i = 0; i < 2; i++) {
    const candidate = {
      ...result,
      paint: {
        ...result.paint,
        target: [...result.paint.target],
        current: [...result.paint.current],
        omitted: [...result.paint.omitted] as [number, number],
      },
    };
    let added = false;
    // The two inventories remain independent. Emit this small observation
    // block whole so a few bytes do not hide one side of the evidence.
    for (const [side, key] of [
      [0, 'target'],
      [1, 'current'],
    ] as const) {
      const group = candidates[side]?.[i];
      if (!group) continue;
      candidate.paint[key].push(group);
      candidate.paint.omitted[side] -= group.count;
      added = true;
    }
    if (added && fitsFocusedEvidence(anchor, candidate)) {
      result = candidate;
      anchor = result;
    }
  }
  if (!result.paint.target.length && !result.paint.current.length) {
    if ((!failures && !unavailable.length) || !fitsFocusedEvidence(packet, result))
      return packet;
  }

  // The shorter routing instruction leaves room for omission metadata without
  // evicting a geometry match or its confidence/provenance.
  return result;
}
