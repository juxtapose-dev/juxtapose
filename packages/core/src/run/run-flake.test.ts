import sharp from 'sharp';
import { beforeAll, expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type {
  BaselineStore,
  Snapshot,
  StoryManifest,
  StructureElement,
  StructureSnapshot,
} from '../types.js';
import { runCapture, type RunOptions } from './run.js';

// A story whose two captures differ is explained in the report (#190): the
// recheck hands both captures to the flake classifier.

const VIEWPORT = { width: 64, height: 64 };
let images: Buffer[];
let seen: string[] = [];

const element = (over: Partial<StructureElement>): StructureElement => ({
  path: 'html>body>img',
  parent: null,
  tag: 'img',
  rect: { x: 0, y: 0, w: 32, h: 32 },
  paintOrder: 0,
  styles: {},
  ...over,
});
const structure = (elements: StructureElement[]): StructureSnapshot => ({
  schema: 'juxtapose.structure/v1',
  viewport: VIEWPORT,
  structureHash: 'h',
  contentHeight: 64,
  elements,
});

const solid = (rgb: [number, number, number]) =>
  sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .webp({ lossless: true })
    .toBuffer();

beforeAll(async () => {
  images = [await solid([255, 0, 0]), await solid([0, 0, 255])];
});

vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: StoryManifest[]) =>
    (async function* () {
      for (const story of stories) {
        seen.push(story.storyId);
        const n = seen.filter((id) => id === story.storyId).length;
        const snapshot: Snapshot = {
          storyId: story.storyId,
          image: story.storyId === 'steady' ? images[0]! : images[n - 1]!,
          viewport: VIEWPORT,
          capturedAt: '',
          durationMs: 1,
          structure: structure([
            element({
              classes: ['cover'],
              external: [
                { kind: 'image', origin: 'https://picsum.photos', path: '/200' },
              ],
            }),
          ]),
        };
        yield { story, durationMs: 1, snapshot };
      }
    })(),
}));
vi.mock('../capture/env.js', () => ({
  captureEnv: () => ({ browser: 'x', os: 'y', encoder: 'z' }),
}));

const story = (
  storyId: string,
  network?: StoryManifest['params']['network'],
): StoryManifest => ({
  storyId,
  title: 't',
  name: storyId,
  componentPath: '',
  params: network ? { network } : {},
});

/** The first capture, as `onArtifact` would have stored it. */
const storedFirst = async () => ({
  image: images[0]!,
  structure: structure([
    element({
      classes: ['cover'],
      external: [{ kind: 'image', origin: 'https://picsum.photos', path: '/200' }],
    }),
  ]),
});
const reads: string[] = [];

async function run(
  stories: StoryManifest[],
  readFirstCapture: RunOptions['readFirstCapture'] | null = async (id) => {
    reads.push(id);
    return storedFirst();
  },
) {
  seen = [];
  reads.length = 0;
  const store: BaselineStore = {
    get: async () => null,
    put: async () => {},
    remove: async () => {},
    readManifest: async () => ({ version: 1, baselines: {} }),
    writeManifest: async () => {},
  };
  return runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store,
    baseUrl: 'about:blank',
    stories,
    totalCount: stories.length,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
    ...(readFirstCapture ? { readFirstCapture } : {}),
  });
}

test('an unstable story carries the cause and the exact fix; a stable one carries none', async () => {
  const r = await run([story('card--basic'), story('steady')]);
  const flaky = r.results.find((x) => x.storyId === 'card--basic')!;
  expect(flaky.unstable).toBeDefined();
  expect(flaky.flake).toMatchObject({
    cause: 'external-image',
    confidence: 'high',
    evidence: { host: 'picsum.photos', selector: 'img.cover' },
    fix: {
      stories: { 'card--basic': { network: { external: { images: 'placeholder' } } } },
    },
  });
  expect(r.results.find((x) => x.storyId === 'steady')!.flake).toBeUndefined();
});

test('a story that already placeholders images is not told to do it again', async () => {
  const r = await run([story('card--basic', { external: { images: 'placeholder' } })]);
  const flaky = r.results[0]!;
  expect(flaky.unstable).toBeDefined();
  expect(flaky.flake?.cause).not.toBe('external-image');
});

test('three unstable stories under one host add a run-level group; two do not', async () => {
  const three = await run([story('c--1'), story('a--1'), story('b--1')]);
  expect(three.flakeGroups).toEqual([
    {
      cause: 'external-image',
      host: 'picsum.photos',
      storyIds: ['a--1', 'b--1', 'c--1'],
      fix: {
        network: {
          rules: [{ match: 'https://picsum.photos/**', action: 'placeholder' }],
        },
      },
    },
  ]);
  // The per-story flake stays.
  expect(three.results.every((r) => r.flake?.cause === 'external-image')).toBe(true);
  const two = await run([story('a--1'), story('b--1')]);
  expect(two.flakeGroups).toBeUndefined();
});

test('the first capture is read back from storage only for a story that turned out unstable', async () => {
  await run([story('card--basic'), story('steady')]);
  expect(reads).toEqual(['card--basic']);
});

test('a first capture that cannot be read, or analysis that throws, leaves the story unstable with no flake', async () => {
  for (const reader of [
    async () => undefined,
    async () => {
      throw new Error('disk gone');
    },
    async () => ({ image: Buffer.from('not an image') }),
  ]) {
    const r = await run([story('card--basic')], reader);
    expect(r.results[0]!.unstable).toBeDefined();
    expect(r.results[0]!.flake).toBeUndefined();
  }
  // And with no reader at all.
  const none = await run([story('card--basic')], null);
  expect(none.results[0]!.unstable).toBeDefined();
  expect(none.results[0]!.flake).toBeUndefined();
});
