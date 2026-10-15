// Where the published schema (strict, for editors) and the runtime checks
// disagree, pinned. The runtime checks only what it checked before #178 and
// the schema describes every option, so some gaps are by design; what this
// test stops is a NEW gap appearing unnoticed. If it fails: either fix the
// schema or the runtime check so they agree, or, when the gap is deliberate,
// add the input below with the reason. Accept/reject at runtime is not
// changed here.
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { checkProjectSettle } from '../capture/settle-options.js';
import { expandVariants } from '../capture/variants.js';
import type { StoryManifest } from '../types.js';
import { ProjectConfigSchema } from './schema.js';
import './validate.js'; // registers the formats Value.Check needs

/** Configs at the edges of every option: a valid value and the invalid ones
 *  the runtime or the schema refuses. */
const CORPUS: unknown[] = [
  { comparison: { mode: 'pixelmatch', threshold: 0.05 } },
  { comparison: { mode: 'exact' } },
  { comparison: { mode: 'other' } },
  { comparison: { mode: 'pixelmatch', threshold: -1 } },
  { comparison: { mode: 'pixelmatch', threshold: 2 } },
  { comparison: { mode: 'pixelmatch', maxDiffPixels: 10 } },
  { variants: { mobile: { comparison: { mode: 'other' } } } },
  { storyTimeout: 999 },
  { storyTimeout: 1.5 },
  { storyTimeout: 2147483648 },
  { freshRenderer: 'x' },
  { recheck: 'x' },
  { recheck: 'off' },
  { recheck: false },
  { delay: -1 },
  { delay: '1' },
  { waitForSelector: 3 },
  { waitForSelector: '' },
  { waitForSelector: 'text=x' },
  { settle: { timeout: 0 } },
  { settle: { timeout: 60001 } },
  { settle: { timeout: 1.5 } },
  { settle: { ready: 1 } },
  { settle: { network: { ignore: ['type:Bogus'] } } },
  { settle: { network: { ignore: 'x' } } },
  { settle: { network: { ignore: [1] } } },
  { settle: { network: { ignore: [''] } } },
  { settle: { network: { require: ['['] } } },
  { settle: { network: { foo: 1 } } },
  { settle: { foo: 1 } },
  { settle: null },
  { settle: [] },
  { network: { external: 'x' } },
  { network: { external: 'block' } },
  { network: { external: { default: 'block', images: 'placeholder' } } },
  { network: { external: { default: 'placeholder' } } },
  { network: { external: { images: 'maybe' } } },
  { network: { external: { image: 'block' } } },
  { network: { external: 'placeholder' } },
  { network: { rules: [{ match: 'https://a/**', action: 'block' }] } },
  { network: { rules: [{ match: 'https://a/**', action: 'nope' }] } },
  { network: { rules: [{ match: 'type:Bogus', action: 'block' }] } },
  { network: { rules: [{ match: 'type:Image', action: 'placeholder' }] } },
  { network: { rules: [{ match: 'https://a/**' }] } },
  { network: { rules: [{ match: 'type:Script', action: 'placeholder' }] } },
  { network: { rules: 'x' } },
  { network: { foo: 1 } },
  { network: null },
  { stories: { '': {} } },
  { stories: { ' ': {} } },
  { stories: { a: { mask: ['text=x'] } } },
  { stories: { a: { mask: [''] } } },
  { stories: { a: { mask: [] } } },
  { stories: { a: { viewport: { width: 1, height: 1 } } } },
  { stories: { a: { animations: 'play' } } },
  { stories: { a: { skip: 1 } } },
  { stories: { a: { delay: -1 } } },
  { stories: { a: { captureTimeout: 0 } } },
  { stories: { a: { threshold: 2 } } },
  { stories: { a: { minDiffPercent: 101 } } },
  { stories: { a: { waitForSelector: '' } } },
  { stories: { a: { liveCapture: false } } },
  { stories: { a: { variants: {} } } },
  { stories: { a: { foo: 1 } } },
  { stories: { a: 5 } },
  { stories: { a: null } },
  { stories: [] },
  { stories: { a: { settle: { timeout: 0 } } } },
  { stories: { a: { network: { external: 'x' } } } },
  { stories: { a: { colorScheme: 'dark' } } },
  { variants: { a: {} } },
  { variants: { a: false } },
  { variants: { a: true } },
  { variants: { a: null } },
  { variants: { a: 5 } },
  { variants: { a: [] } },
  { variants: { A: {} } },
  { variants: { a_b: {} } },
  { variants: { '': {} } },
  { variants: { a: { skip: true } } },
  { variants: { a: { skip: false } } },
  { variants: { a: { colorScheme: 'x' } } },
  { variants: { a: { colorScheme: 'dark' } } },
  { variants: { a: { extends: 'b' } } },
  { variants: { a: { extends: 'a' } } },
  { variants: { a: { extends: 'b' }, b: { extends: 'a' } } },
  { variants: { a: { extends: 1 } } },
  { variants: { a: { viewport: 'x' } } },
  { variants: { a: { viewport: { width: 0, height: 1 } } } },
  { variants: { a: { viewport: { width: 1, height: 1 } } } },
  { variants: { a: { mask: 'x' } } },
  { variants: { a: { mask: ['text=x'] } } },
  { variants: { a: { delay: -1 } } },
  { variants: { a: { threshold: 2 } } },
  { variants: { a: { animations: 'x' } } },
  { variants: { a: { captureAfterPlay: 'x' } } },
  { variants: { a: { liveCapture: false } } },
  { variants: { a: { variants: {} } } },
  { variants: { a: { foo: 1 } } },
  { variants: { a: { settle: { timeout: 0 } } } },
  { variants: { a: { network: { external: 'x' } } } },
  { viewport: { width: 0, height: 1 } },
  { viewport: 'x' },
  { viewport: { width: 1.5, height: 1 } },
  { viewport: { width: 1, height: 1, dpr: 2 } },
  { concurrency: 0 },
  { concurrency: 'x' },
  { concurrency: 1.5 },
  { threshold: 2 },
  { minDiffPercent: -1 },
  { warmSwitch: 'x' },
  { buildDir: 1 },
  { origin: 1 },
  { platform: 'x' },
  { platform: 'urls' },
  { urls: 'x' },
  { urls: [{ id: 'a', url: '/a' }] },
  { urls: [{ id: 'a' }] },
  { urls: [{ id: 'a', url: '/a', params: { delay: -1 } }] },
  { urls: [{ id: 'a', url: '/a', params: { foo: 1 } }] },
  { urls: [{ id: 'a', url: '/a', variants: { a: { extends: 'zz' } } }] },
  { storage: { kind: 's3' } },
  { storage: { kind: 'fs' } },
  { storage: { kind: 'fs', dir: 'x' } },
  { storage: { kind: 'git' } },
  { storage: { kind: 'git', dir: 1 } },
  { storage: { kind: 'x' } },
  { storage: { kind: 'git', foo: 1 } },
  { storage: 'x' },
  { mcp: { concurrency: 0 } },
  { mcp: { concurrency: 17 } },
  { mcp: { concurrency: 1.5 } },
  { mcp: { foo: 1 } },
  { mcp: { concurrency: 4 } },
  { $schema: 1 },
  { $schema: 'x' },
  { foo: 1 },
  {},
  { unrelated: {} },
];

/** The schema accepts, the runtime refuses: what a schema can't say. */
const SCHEMA_ONLY_ACCEPTS = [
  // A `placeholder` rule that only matches a type with no stand-in (type:Script).
  '{"network":{"rules":[{"match":"type:Script","action":"placeholder"}]}}',
  // A variant's `extends` must name a variant that exists, without a cycle.
  '{"variants":{"a":{"extends":"b"}}}',
  '{"variants":{"a":{"extends":"a"}}}',
  '{"variants":{"a":{"extends":"b"},"b":{"extends":"a"}}}',
];

/** The schema refuses, the runtime accepts: options the runtime has never
 *  checked (variant fields other than skip/colorScheme/settle/network/extends;
 *  viewport, concurrency, threshold, minDiffPercent, warmSwitch, buildDir,
 *  origin, platform, urls, storage, mcp and $schema at the top level; unknown
 *  keys, which only warn). `mcp.concurrency` is checked by `jux mcp` itself. */
const SCHEMA_ONLY_REFUSES = [
  '{"variants":{"a":{"viewport":"x"}}}',
  '{"variants":{"a":{"viewport":{"width":0,"height":1}}}}',
  '{"variants":{"a":{"mask":"x"}}}',
  '{"variants":{"a":{"mask":["text=x"]}}}',
  '{"variants":{"a":{"delay":-1}}}',
  '{"variants":{"a":{"threshold":2}}}',
  '{"variants":{"a":{"animations":"x"}}}',
  '{"variants":{"a":{"captureAfterPlay":"x"}}}',
  '{"variants":{"a":{"liveCapture":false}}}',
  '{"variants":{"a":{"variants":{}}}}',
  '{"variants":{"a":{"foo":1}}}',
  '{"viewport":{"width":0,"height":1}}',
  '{"viewport":"x"}',
  '{"viewport":{"width":1.5,"height":1}}',
  '{"viewport":{"width":1,"height":1,"dpr":2}}',
  '{"concurrency":0}',
  '{"concurrency":"x"}',
  '{"concurrency":1.5}',
  '{"threshold":2}',
  '{"minDiffPercent":-1}',
  '{"warmSwitch":"x"}',
  '{"buildDir":1}',
  '{"origin":1}',
  '{"platform":"x"}',
  '{"urls":"x"}',
  '{"urls":[{"id":"a"}]}',
  '{"urls":[{"id":"a","url":"/a","params":{"delay":-1}}]}',
  '{"urls":[{"id":"a","url":"/a","params":{"foo":1}}]}',
  '{"storage":{"kind":"s3"}}',
  '{"storage":{"kind":"fs"}}',
  '{"storage":{"kind":"git","dir":1}}',
  '{"storage":{"kind":"x"}}',
  '{"storage":{"kind":"git","foo":1}}',
  '{"storage":"x"}',
  '{"mcp":{"concurrency":0}}',
  '{"mcp":{"concurrency":17}}',
  '{"mcp":{"concurrency":1.5}}',
  '{"mcp":{"foo":1}}',
  '{"$schema":1}',
  '{"foo":1}',
  '{"unrelated":{}}',
];

const story = {
  storyId: 'a--b',
  title: 'a',
  name: 'b',
  params: {},
} as unknown as StoryManifest;

function runtimeAccepts(config: unknown): boolean {
  try {
    checkProjectSettle(config);
    const c = config as { variants?: never; stories?: never };
    expandVariants([story], c.variants, c.stories);
    return true;
  } catch {
    return false;
  }
}

describe('schema vs runtime drift', () => {
  it('disagree on exactly the pinned inputs', () => {
    const schemaOnlyAccepts: string[] = [];
    const schemaOnlyRefuses: string[] = [];
    for (const c of CORPUS) {
      const schema = Value.Check(ProjectConfigSchema, c);
      if (schema === runtimeAccepts(c)) continue;
      (schema ? schemaOnlyAccepts : schemaOnlyRefuses).push(JSON.stringify(c));
    }
    expect(schemaOnlyAccepts).toEqual(SCHEMA_ONLY_ACCEPTS);
    expect(schemaOnlyRefuses).toEqual(SCHEMA_ONLY_REFUSES);
  });
});
