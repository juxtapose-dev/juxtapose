import { expect, test } from 'vitest';
import type { DiffResult } from '../types.js';
import { describeRendererRetries } from './renderer-retry.js';

test('resolved stories get sorted, copyable exact overrides; cap is visible', () => {
  const results = [
    ['z', 'resolved'],
    ['a', 'resolved'],
    ['b', 'cap'],
  ].map(([storyId, outcome]) => ({
    storyId,
    rendererRetry: { outcome },
  })) as DiffResult[];
  const text = describeRendererRetries(results);
  expect(text).toContain('2 stories passed only after a fresh retry.');
  expect(text).toContain('1 failures left without a retry');
  const config = JSON.parse(text.slice(text.indexOf('{')));
  expect(Object.keys(config.stories)).toEqual(['a', 'z']);
  expect(config.stories.a).toEqual({ renderer: { shared: false } });
  expect(describeRendererRetries([])).toBe('');
});

test('pulse recovery recommends cache clearing while preserving sharing', () => {
  const text = describeRendererRetries([
    {
      storyId: 'card',
      rendererRetry: { outcome: 'resolved', resolvedBy: 'cache-pulse' },
    } as DiffResult,
  ]);
  expect(text).toContain('1 stories passed after a cache-pulse retry.');
  expect(JSON.parse(text.slice(text.indexOf('{'))).stories.card).toEqual({
    renderer: { shared: true, clearResourceCache: true },
  });
});
