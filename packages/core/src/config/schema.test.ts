import { readFileSync, readdirSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { checkProjectSettle } from '../capture/settle-options.js';
import { expandVariants } from '../capture/variants.js';
import type { StoryManifest } from '../types.js';
import { configJsonSchemaText } from './json-schema.js';
import { ProjectConfigSchema, type ProjectConfig } from './schema.js';
import './validate.js'; // registers the custom formats Value.Check needs

const root = new URL('../../../../', import.meta.url);

describe('schema.json', () => {
  it('is the committed output of the schema (pnpm build regenerates it)', () => {
    const committed = readFileSync(new URL('packages/core/schema.json', root), 'utf8');
    expect(committed).toBe(configJsonSchemaText());
  });

  it('allows the $schema line jux init writes', () => {
    expect(
      Value.Check(ProjectConfigSchema, {
        $schema: './node_modules/@juxtapose/core/schema.json',
        platform: 'storybook',
      }),
    ).toBe(true);
  });

  it('flags a typo an editor should catch', () => {
    expect(Value.Check(ProjectConfigSchema, { concurency: 8 })).toBe(false);
    expect(Value.Check(ProjectConfigSchema, { stories: { a: { dely: 1 } } })).toBe(false);
  });
});

/** Every ```json block in docs/*.md whose top-level keys are all config keys:
 *  the rest are verdicts, MCP client settings and the like. */
function docsConfigExamples(): Array<{ at: string; config: ProjectConfig }> {
  const keys = new Set(Object.keys(ProjectConfigSchema.properties));
  const out: Array<{ at: string; config: ProjectConfig }> = [];
  const dir = new URL('docs/', root);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      const value = JSON.parse(m[1]!) as Record<string, unknown>;
      if (!Object.keys(value).every((k) => keys.has(k))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ at: `docs/${file}:${line}`, config: value as ProjectConfig });
    }
  }
  return out;
}

describe('docs config examples', () => {
  const examples = docsConfigExamples();

  it('are found', () => {
    // Six in configuration.md and one in mcp.md; fewer means the filter broke.
    expect(examples.length).toBeGreaterThanOrEqual(7);
  });

  it.each(examples)(
    '$at passes the published schema and the runtime checks',
    ({ config }) => {
      expect([...Value.Errors(ProjectConfigSchema, config)].map((e) => e.path)).toEqual(
        [],
      );
      expect(() => checkProjectSettle(config)).not.toThrow();
      const story = {
        storyId: 'a--b',
        title: 'A',
        name: 'B',
        importPath: '',
        params: {},
      };
      expect(() =>
        expandVariants([story as StoryManifest], config.variants, config.stories),
      ).not.toThrow();
    },
  );
});
