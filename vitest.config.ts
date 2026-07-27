import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Resolve workspace packages to source, not to dist.
  //
  // Without this, a test importing `@juxtapose/core` by package name follows
  // the workspace symlink to `main: ./dist/index.js`, so `pnpm test` on a fresh
  // clone fails with "Failed to resolve entry for package" — an error that
  // blames core's package.json, which is innocent. It also means tests would
  // run against the last build rather than the working tree.
  resolve: {
    alias: {
      '@juxtapose/core': src('core'),
      '@juxtapose/server': src('server'),
      '@juxtapose/adapter-storybook': src('adapter-storybook'),
      '@juxtapose/adapter-ladle': src('adapter-ladle'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Dot output suits CI; locally you want to see which test failed.
    reporters: process.env.CI ? ['dot'] : ['default'],
  },
});
