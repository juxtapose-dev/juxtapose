// Writes schema.json (published as @juxtapose/core/schema.json) from the
// built config schema. Run by `pnpm build`; src/config/schema.test.ts fails
// when the committed file is stale.
import { writeFileSync } from 'node:fs';
import { configJsonSchemaText } from '../dist/config/json-schema.js';

writeFileSync(new URL('../schema.json', import.meta.url), configJsonSchemaText());
