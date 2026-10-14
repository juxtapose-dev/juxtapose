// The published JSON Schema: config/schema.ts serialized. ErrorText and
// TypeBox's own bookkeeping are symbols, so JSON leaves them out.
import { createRequire } from 'node:module';
import { ProjectConfigSchema } from './schema.js';

export const JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

/** `@juxtapose/core/schema.json`, as an object. */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    ...(JSON.parse(JSON.stringify(ProjectConfigSchema)) as Record<string, unknown>),
  };
}

/** The file's exact text; scripts/write-schema.mjs writes it at build and a
 *  test holds the committed copy to it. */
export const configJsonSchemaText = (): string =>
  JSON.stringify(configJsonSchema(), null, 2) + '\n';

/** Where the published schema of this exact version lives on a CDN: what
 *  `jux init` writes as `$schema`. Pinned, so an editor checks a config
 *  against the options the installed jux knows, and it resolves whether or
 *  not the package manager hoists @juxtapose/core into node_modules. */
export function configSchemaUrl(): string {
  // ../../package.json from src/config and dist/config alike.
  const { version } = createRequire(import.meta.url)('../../package.json') as {
    version: string;
  };
  return `https://cdn.jsdelivr.net/npm/@juxtapose/core@${version}/schema.json`;
}
