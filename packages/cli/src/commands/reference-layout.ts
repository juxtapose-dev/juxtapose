import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  decodeStructure,
  extractTargetEvidence,
  matchTargetLayout,
  type TargetEvidence,
  type TargetLayoutResult,
} from '@juxtapose/core';
import { isRecord } from '../guards.js';
import { memo, cacheDirectory, derived } from './reference-derived-cache.js';
import {
  ReferencePaintAnalyzer,
  currentElementText,
  isPaint,
  type TargetTextProvider,
  type ObservedImage,
  type ReferencePaintDetail,
} from './reference-paint.js';

// Change the directory version when segmentation, matching or evidence meaning
// changes. The 39-pair feasibility study does not justify default MCP output.
const VERSION = 3;
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
  paint?: ReferencePaintDetail;
};

/** One MCP session reuses small derived evidence, never full decoded frames.
 * On restart the content-addressed disk cache serves identical requests. */
export class ReferenceLayoutCache {
  private readonly images = new Map<string, Promise<ObservedImage>>();
  private readonly paint?: ReferencePaintAnalyzer;
  constructor(provider?: TargetTextProvider) {
    if (provider) this.paint = new ReferencePaintAnalyzer(provider);
  }
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
    const cache = await cacheDirectory(project);
    const evidence = (image: Buffer, imageHash: string, role: 'target' | 'current') => {
      const paintKey = this.paint
        ? `paint-image-v2-${hash(JSON.stringify([imageHash, role, role === 'target' ? this.paint.provider.cacheKey : null]))}`
        : null;
      const imageKey = `${project}:${paintKey ?? imageHash}`;
      const pending = memo(this.images, imageKey, async () => {
        if (!this.paint || !paintKey)
          return {
            layout: await derived(cache, `image-${imageHash}`, isEvidence, () =>
              extractTargetEvidence(image),
            ),
          };
        const valid = (value: unknown): value is ObservedImage =>
          isRecord(value) &&
          isEvidence(value.layout) &&
          isPaint(value.paint) &&
          value.paint.providerFailures === 0 &&
          value.paint.frameHash === imageHash &&
          value.layout.width === value.paint.width &&
          value.layout.height === value.paint.height;
        return derived(
          cache,
          paintKey,
          valid,
          async () => {
            let paint: ObservedImage['paint'];
            const layout = await extractTargetEvidence(
              image,
              async (rgba, components) => {
                try {
                  paint = await this.paint!.observe(
                    rgba,
                    components,
                    imageHash,
                    role,
                    cache,
                  );
                } catch {
                  paint = { status: 'unavailable', reason: 'text-provider-unavailable' };
                }
              },
            );
            return { layout, paint };
          },
          (value) =>
            value.paint?.status === 'measured' && value.paint.providerFailures === 0,
        );
      });
      // A partial provider failure must be retryable, while the same request's
      // geometry remains valid. Pending work stays shared until it settles.
      void pending.then(
        (value) => {
          if (
            this.paint &&
            (value.paint?.status !== 'measured' || value.paint.providerFailures > 0) &&
            this.images.get(imageKey) === pending
          )
            this.images.delete(imageKey);
        },
        () => {},
      );
      return pending;
    };
    // One image promise supplies geometry and optional text; saved geometry-pair
    // hits still obtain text from the versioned image cache, without recapture.
    const observed = this.paint
      ? Promise.all([
          evidence(input.reference, referenceHash, 'target'),
          evidence(input.current, currentHash, 'current'),
        ])
      : undefined;
    const result = await memo(this.pairs, `${project}:${key}`, () =>
      derived(cache, `pair-${key}`, isLayout, async () => {
        const [target, current] = await (observed ??
          Promise.all([
            evidence(input.reference, referenceHash, 'target'),
            evidence(input.current, currentHash, 'current'),
          ]));
        return matchTargetLayout(
          target.layout,
          current.layout,
          decodeStructure(input.structure),
        );
      }),
    );
    const paint = observed ? await observed : undefined;
    const confidenceRules: Record<string, string> = {};
    const ruleIds = new Map<string, string>();
    const matches = result.matches.map((match) => {
      let rule = ruleIds.get(match.confidenceRule);
      if (!rule) {
        rule = `paint-${ruleIds.size + 1}`;
        ruleIds.set(match.confidenceRule, rule);
        confidenceRules[rule] = match.confidenceRule;
      }
      const { element, targetBox, currentBox, paintedFill, dx, dy, dw, dh, provenance } =
        match;
      return {
        element: {
          label: element.label,
          ...(element.id ? { id: element.id } : { path: element.path }),
          provenance: element.provenance,
        },
        targetBox,
        currentBox,
        paintedFill,
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
      omittedMatches: 0,
      ...(paint
        ? {
            paint: {
              target: paint[0].paint ?? {
                status: 'unavailable' as const,
                reason: 'no-paint-evidence',
              },
              current: currentElementText(
                paint[1].paint ?? { status: 'unavailable', reason: 'no-paint-evidence' },
                decodeStructure(input.structure),
              ),
            },
          }
        : {}),
    };
  }
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
    value['matches'].every(
      (match: unknown) =>
        isRecord(match) &&
        isRecord(match['paintedFill']) &&
        match['paintedFill']['targetCurrentEqual'] === true &&
        Array.isArray(match['paintedFill']['rgb']) &&
        match['paintedFill']['rgb'].length === 3 &&
        match['paintedFill']['rgb'].every(
          (channel: unknown) =>
            Number.isInteger(channel) &&
            (channel as number) >= 0 &&
            (channel as number) <= 255,
        ),
    ) &&
    typeof value['abstained'] === 'number'
  );
}
