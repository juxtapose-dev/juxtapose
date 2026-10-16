import { expect, test } from 'vitest';
import { selectStories, discoveryStoryIds } from './story-selection.js';
const stories = [
  { storyId: 'charts-line--basic' },
  { storyId: 'charts-line--basic__dark', baseStoryId: 'charts-line--basic' },
  { storyId: 'table--basic' },
  { storyId: 'table--basic__dark', baseStoryId: 'table--basic' },
];
test('union, stable order, variants and unmatched selectors', () => {
  const result = selectStories(stories, ['charts-*', 'charts-line--basic', 'missing*']);
  expect(result.selected).toEqual(stories.slice(0, 2));
  expect(result.unknown).toEqual(['missing*']);
  expect(selectStories(stories, ['*__dark']).selected).toEqual([stories[1], stories[3]]);
});
test('literal punctuation, question marks and slash-aware globs', () => {
  const items = ['a.b', 'axb', 'a/b', 'a/b/c'].map((storyId) => ({ storyId }));
  expect(selectStories(items, ['a.b']).selected).toEqual([items[0]]);
  expect(selectStories(items, ['a?b']).selected).toEqual(items.slice(0, 2));
  expect(selectStories(items, ['a/*']).selected).toEqual([items[2]]);
  expect(selectStories(items, ['a/**']).selected).toEqual(items.slice(2));
});
test('discovery includes possible live variants and narrows literal prefixes', () => {
  const bases = stories.filter((s) => !s.baseStoryId);
  expect(discoveryStoryIds(bases, ['charts-*'])).toEqual(['charts-line--basic']);
  expect(discoveryStoryIds(bases, ['charts-line--basic__live'])).toEqual([
    'charts-line--basic',
  ]);
  expect(discoveryStoryIds(bases, ['*__live'])).toEqual(bases.map((s) => s.storyId));
  expect(discoveryStoryIds(bases, ['missing*'])).toEqual([]);
});
