// Ships @juxtapose/core's schema.json inside @juxtapose/cli too, so
// `./node_modules/@juxtapose/cli/schema.json` works offline under pnpm, which
// only links a project's direct dependencies into node_modules. A build
// product, not committed: core's copy is the source.
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const from = createRequire(import.meta.url).resolve('@juxtapose/core/schema.json');
copyFileSync(from, new URL('../schema.json', import.meta.url));
