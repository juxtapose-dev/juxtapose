// Which third-party requests a story's network config already answers, so the
// classifier never suggests a setting that is on.

import { compileOverrides, resolveOverride } from '../capture/story-overrides.js';
import { resolveNetwork } from '../capture/network-rules.js';
import type { NetworkParams, ProjectConfig } from '../types.js';
import type { NetworkCoverage } from './classify.js';

/** Coverage from network layers, lowest first (project, story, call). */
export function networkCoverage(
  ...layers: Array<NetworkParams | undefined>
): NetworkCoverage {
  try {
    const policy = resolveNetwork(...layers);
    // A type's own entry beats `default`, so an explicit `allow` stays open
    // even when `default` blocks.
    const answered = (action: string | undefined) =>
      action === undefined ? policy.default === 'block' : action !== 'allow';
    return { images: answered(policy.images), frames: answered(policy.frames) };
  } catch {
    return { images: false, frames: false };
  }
}

/** Coverage from the project config alone: its `network` and the `stories`
 *  overrides that match the capture. What a story's own `parameters` add is
 *  not known without enumerating the workbench. */
export function configCoverage(
  config: ProjectConfig,
  capture: { storyId: string; baseStoryId?: string },
): NetworkCoverage {
  try {
    const hit = resolveOverride(compileOverrides(config.stories), capture);
    return networkCoverage(config.network, hit?.override.network);
  } catch {
    return { images: false, frames: false };
  }
}
