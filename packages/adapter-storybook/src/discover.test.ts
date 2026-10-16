import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@juxtapose/core';
import { StorybookPlatform } from './index.js';

// Execute the serialized callback as the browser would: it cannot close over
// module helpers, and importing an unrelated CSF is observable here.
function previewPage(preview: unknown): Page {
  return {
    goto: vi.fn(),
    evaluate: async (fn: string | ((arg: unknown) => unknown), arg: unknown) =>
      runInNewContext(`(${fn.toString()})(arg)`, {
        window: { __STORYBOOK_PREVIEW__: preview },
        arg,
        setTimeout,
      }),
  } as unknown as Page;
}

function fixture(api: 'preview' | 'store' | 'none' = 'preview') {
  const imports = new Set<string>();
  const entries = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [`story-${i}`, { type: 'story' }]),
  );
  const params = {
    viewport: { width: 320, height: 480 },
    variants: { dark: { colorScheme: 'dark' } },
  };
  const loadStory = vi.fn(async function (
    this: unknown,
    { storyId }: { storyId: string },
  ) {
    expect(this).toBe(api === 'preview' ? preview : store);
    imports.add(storyId);
    return { parameters: { juxtapose: params } };
  });
  const cacheAllCSFFiles = vi.fn(async () => {
    for (const id of Object.keys(entries)) imports.add(id);
  });
  const store = {
    storyIndex: { entries },
    cacheAllCSFFiles,
    ...(api === 'store' ? { loadStory } : {}),
  };
  const extract = vi.fn(async () => ({
    'story-0': { parameters: { juxtapose: params } },
  }));
  const preview = {
    storyStoreValue: store,
    extract,
    ...(api === 'preview' ? { loadStory } : {}),
  };
  return {
    page: previewPage(preview),
    imports,
    params,
    loadStory,
    cacheAllCSFFiles,
    extract,
  };
}

describe('StorybookPlatform.discoverParams', () => {
  it.each(['preview', 'store'] as const)(
    'imports only selected CSFs with the %s loadStory API',
    async (api) => {
      const f = fixture(api);
      const found = await new StorybookPlatform().discoverParams(f.page, 'http://x', [
        'story-0',
        'story-4',
        'story-0',
      ]);
      expect([...f.imports]).toEqual(['story-0', 'story-4']);
      expect(f.loadStory).toHaveBeenCalledTimes(2);
      expect(f.cacheAllCSFFiles).not.toHaveBeenCalled();
      expect(f.extract).not.toHaveBeenCalled();
      expect(Object.fromEntries(found)).toEqual({
        'story-0': f.params,
        'story-4': f.params,
      });
    },
  );

  it('keeps whole-store extraction for full selections and omitted selections', async () => {
    for (const ids of [undefined, Array.from({ length: 1000 }, (_, i) => `story-${i}`)]) {
      const f = fixture();
      await new StorybookPlatform().discoverParams(f.page, 'http://x', ids);
      expect(f.cacheAllCSFFiles).toHaveBeenCalledOnce();
      expect(f.extract).toHaveBeenCalledWith({ includeDocsOnly: false });
      expect(f.loadStory).not.toHaveBeenCalled();
    }
  });

  it('falls back to extraction when per-story APIs are absent', async () => {
    const f = fixture('none');
    const found = await new StorybookPlatform().discoverParams(f.page, 'http://x', [
      'story-0',
    ]);
    expect(found.get('story-0')).toEqual(f.params);
    expect(f.extract).toHaveBeenCalledOnce();
  });

  it('does not navigate for an empty selection', async () => {
    const f = fixture();
    expect(await new StorybookPlatform().discoverParams(f.page, 'http://x', [])).toEqual(
      new Map(),
    );
    expect(f.page.goto).not.toHaveBeenCalled();
  });

  it('filters malformed params and permits stories without params', async () => {
    const page = previewPage({
      storyStoreValue: {},
      loadStory: async ({ storyId }: { storyId: string }) => ({
        parameters: {
          juxtapose: storyId === 'array' ? [] : storyId === 'null' ? null : undefined,
        },
      }),
    });
    expect(
      await new StorybookPlatform().discoverParams(page, 'http://x', [
        'array',
        'null',
        'missing',
      ]),
    ).toEqual(new Map());
  });

  it('propagates per-story failures rather than importing everything', async () => {
    const f = fixture();
    f.loadStory.mockRejectedValueOnce(new Error('broken CSF'));
    await expect(
      new StorybookPlatform().discoverParams(f.page, 'http://x', ['story-0']),
    ).rejects.toThrow('broken CSF');
    expect(f.extract).not.toHaveBeenCalled();
  });
});

describe('StorybookPlatform.discoveryKey', () => {
  it('isolates selections, canonicalizes order, and fingerprints both build inputs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jux-selection-key-'));
    try {
      await writeFile(path.join(dir, 'index.json'), '{}');
      await writeFile(path.join(dir, 'iframe.html'), 'preview-v1');
      const platform = new StorybookPlatform();
      const target = { projectRoot: dir, buildDir: dir };
      const full = await platform.discoveryKey(target);
      const subset = await platform.discoveryKey(target, ['a']);
      expect(subset).not.toBe(full);
      expect(await platform.discoveryKey(target, ['b'])).not.toBe(subset);
      expect(await platform.discoveryKey(target, [])).not.toBe(full);
      expect(await platform.discoveryKey(target, ['a', 'b', 'a'])).toBe(
        await platform.discoveryKey(target, ['b', 'a']),
      );
      await writeFile(path.join(dir, 'iframe.html'), 'preview-v2');
      expect(await platform.discoveryKey(target, ['a'])).not.toBe(subset);
      const next = await platform.discoveryKey(target, ['a']);
      await writeFile(path.join(dir, 'index.json'), '{"v":5}');
      expect(await platform.discoveryKey(target, ['a'])).not.toBe(next);
      expect(
        await platform.discoveryKey({ ...target, origin: 'http://x' }, ['a']),
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
