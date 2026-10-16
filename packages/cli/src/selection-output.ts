import type { StoryManifest } from '@juxtapose/core';
import type { Io } from './io.js';

export function printSelection(
  stories: readonly StoryManifest[],
  json: boolean,
  io: Io,
): number {
  const captures = stories.map(({ storyId, baseStoryId, title, name }) => ({
    storyId,
    ...(baseStoryId ? { baseStoryId } : {}),
    title,
    name,
  }));
  if (json)
    io.out(
      JSON.stringify({
        schema: 'juxtapose.selection/v1',
        count: captures.length,
        captures,
      }) + '\n',
    );
  else {
    for (const capture of captures)
      io.out(`${capture.storyId}\t${capture.title} / ${capture.name}\n`);
    io.out(`${captures.length} captures selected\n`);
  }
  return 0;
}
