import { ComparisonSchema } from '../config/schema.js';
import { validate } from '../config/validate.js';
import type { ProjectConfig, StoryParams } from '../types.js';

/** A story replaces the project policy; omitted threshold uses the policy default. */
export function resolveComparison(
  project?: ProjectConfig['comparison'],
  story?: StoryParams['comparison'],
): Required<NonNullable<StoryParams['comparison']>> {
  if (project !== undefined) validate(ComparisonSchema, project, 'comparison');
  if (story !== undefined) validate(ComparisonSchema, story, 'story comparison');
  return { mode: 'exact', threshold: 0.05, ...(story ?? project) };
}
