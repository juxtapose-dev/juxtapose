import type { ProjectConfig, StoryParams } from '../types.js';
import { RendererSchema } from '../config/schema.js';
import { validate } from '../config/validate.js';

export type RendererSettings = Required<NonNullable<StoryParams['renderer']>>;

/** Resolve before navigation, including legacy project configuration. */
export function resolveRenderer(
  project: Pick<ProjectConfig, 'renderer' | 'freshRenderer'> = {},
  story?: StoryParams['renderer'],
  forceFresh = false,
): RendererSettings {
  if (project.renderer !== undefined)
    validate(RendererSchema, project.renderer, 'renderer');
  if (story !== undefined) validate(RendererSchema, story, 'story renderer');
  if (
    project.freshRenderer !== undefined &&
    project.renderer?.shared !== undefined &&
    project.freshRenderer === project.renderer.shared
  ) {
    throw new Error(
      'jux: renderer.shared conflicts with freshRenderer; remove the legacy setting',
    );
  }
  const settings = {
    shared: project.freshRenderer === false,
    clearResourceCache: false,
    ...project.renderer,
    ...story,
  };
  return forceFresh ? { shared: false, clearResourceCache: false } : settings;
}
