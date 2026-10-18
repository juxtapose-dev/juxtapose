import { readFileSync, readdirSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { checkProjectSettle } from '../capture/settle-options.js';
import { expandVariants } from '../capture/variants.js';
import type { StoryManifest } from '../types.js';
import { configJsonSchemaText, configSchemaUrl } from './json-schema.js';
import {
  JuxtaposeParametersSchema,
  ProjectConfigSchema,
  type ProjectConfig,
} from './schema.js';
import './validate.js'; // registers the custom formats Value.Check needs

const root = new URL('../../../../', import.meta.url);

describe('schema.json', () => {
  it('is the committed output of the schema (pnpm build regenerates it)', () => {
    const committed = readFileSync(new URL('packages/core/schema.json', root), 'utf8');
    expect(committed).toBe(configJsonSchemaText());
  });

  it('has a version-pinned CDN URL for jux init to write', () => {
    const { version } = JSON.parse(
      readFileSync(new URL('packages/core/package.json', root), 'utf8'),
    ) as { version: string };
    expect(configSchemaUrl()).toBe(
      `https://cdn.jsdelivr.net/npm/@juxtapose/core@${version}/schema.json`,
    );
  });

  it('allows the $schema line jux init writes', () => {
    expect(
      Value.Check(ProjectConfigSchema, {
        $schema: './node_modules/@juxtapose/core/schema.json',
        platform: 'storybook',
      }),
    ).toBe(true);
  });

  it('writes string choices as a plain enum, never anyOf of consts', () => {
    const json = JSON.parse(configJsonSchemaText()) as Record<string, unknown>;
    const constUnions: string[] = [];
    const visit = (node: unknown, at: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${at}/${i}`));
      if (typeof node !== 'object' || node === null) return;
      const anyOf = (node as { anyOf?: Array<{ const?: unknown }> }).anyOf;
      if (anyOf?.every((b) => typeof b.const === 'string')) constUnions.push(at);
      for (const [k, v] of Object.entries(node)) visit(v, `${at}/${k}`);
    };
    visit(json, '');
    expect(constUnions).toEqual([]);
    const props = json['properties'] as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(props['network']!.properties!['external']).toMatchObject({
      anyOf: [
        { type: 'string', enum: ['allow', 'block'] },
        { type: 'object', properties: { default: { enum: ['allow', 'block'] } } },
      ],
    });
    expect(props['platform']).toMatchObject({ enum: ['storybook', 'ladle', 'urls'] });
  });

  it('flags a typo an editor should catch', () => {
    expect(Value.Check(ProjectConfigSchema, { concurency: 8 })).toBe(false);
    expect(Value.Check(ProjectConfigSchema, { stories: { a: { dely: 1 } } })).toBe(false);
  });
});

/** JSON blocks in docs/*.md that are not a juxtapose config, by file and
 *  first key. Anything else must be a config: a block that is neither, or
 *  mixes config keys with others, fails rather than being skipped. */
const NOT_CONFIG = [
  'docs/agents.md schema', // a verdict
  'docs/agents.md schema', // a crops result
  'docs/cli.md flake', // a run result's flake
  'docs/cli.md schema', // an explain result
  'docs/mcp.md mcpServers', // MCP client settings
  'docs/mcp.md mcpServers',
  'docs/mcp.md story', // focused saved-element MCP arguments
  'docs/mcp.md story', // saved ancestor MCP arguments
  'docs/mcp.md progress', // an opt-in target-progress result
];

function docsJsonBlocks() {
  const keys = new Set(Object.keys(ProjectConfigSchema.properties));
  const configs: Array<{ at: string; config: ProjectConfig }> = [];
  const others: string[] = [];
  const mixed: string[] = [];
  const params: Array<{ at: string; source: string }> = [];
  const dir = new URL('docs/', root);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    const at = (index: number) =>
      `docs/${file}:${text.slice(0, index).split('\n').length}`;
    for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      const value = JSON.parse(m[1]!) as Record<string, unknown>;
      const own = Object.keys(value).filter((k) => keys.has(k));
      if (own.length === Object.keys(value).length)
        configs.push({ at: at(m.index), config: value as ProjectConfig });
      else if (own.length === 0) others.push(`docs/${file} ${Object.keys(value)[0]}`);
      else mixed.push(at(m.index));
    }
    // Story files: the object after `juxtapose: ` in a js/ts(x) block.
    for (const m of text.matchAll(/```[jt]sx?\n([\s\S]*?)```/g))
      for (const p of m[1]!.matchAll(/juxtapose: \{/g)) {
        const from = p.index + 'juxtapose: '.length;
        let depth = 0;
        let to = from;
        for (; to < m[1]!.length; to++) {
          if (m[1]![to] === '{') depth++;
          else if (m[1]![to] === '}' && --depth === 0) break;
        }
        params.push({ at: at(m.index), source: m[1]!.slice(from, to + 1) });
      }
  }
  return { configs, others, mixed, params };
}

describe('docs examples', () => {
  const { configs, others, mixed, params } = docsJsonBlocks();

  it('are each a config or a known non-config block', () => {
    expect(mixed).toEqual([]);
    expect(others.sort()).toEqual([...NOT_CONFIG].sort());
    // Six in configuration.md and one in mcp.md.
    expect(configs.length).toBeGreaterThanOrEqual(7);
    expect(params.length).toBeGreaterThanOrEqual(1);
  });

  it.each(configs)(
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

  it.each(params)('$at story parameters fit JuxtaposeParameters', ({ source }) => {
    // A literal from our own docs, evaluated as the JS object it is.
    const value = new Function(`return (${source});`)() as unknown;
    expect(
      [...Value.Errors(JuxtaposeParametersSchema, value)].map((e) => e.path),
    ).toEqual([]);
  });
});
