import { describe, it, expect } from 'vitest';
import { watchTargets } from './source.js';
import type { StoryManifest, StoryParams } from '@juxtapose/core';

const story = (storyId: string, params: StoryParams = {}): StoryManifest => ({
  storyId,
  title: storyId,
  name: storyId,
  componentPath: '/src/X.tsx',
  params,
});

describe('watchTargets', () => {
  it('recaptures every story sharing the edited component', () => {
    const ids = watchTargets('a', [story('a'), story('b'), story('c')]);
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips a sibling that opted out of live recapture', () => {
    // A long play function or a deliberate delay makes a keystroke-triggered
    // capture cost more than the feedback returns.
    const ids = watchTargets('a', [story('a'), story('b', { liveCapture: false })]);
    expect(ids).toEqual(['a']);
  });

  it('still captures an opted-out story when it is the one on screen', () => {
    // The opt-out is about collateral recapture, not about refusing to show
    // the developer what they are looking at.
    const ids = watchTargets('b', [story('a'), story('b', { liveCapture: false })]);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('includes the trigger even when the graph walk missed it', () => {
    // A story file the bundler manifest never recorded still has to recapture,
    // or watch mode does nothing for exactly the story being edited.
    expect(watchTargets('a', [])).toEqual(['a']);
  });

  it('does not duplicate the trigger', () => {
    expect(watchTargets('a', [story('a')])).toEqual(['a']);
  });
});
