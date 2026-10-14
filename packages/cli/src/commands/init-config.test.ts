import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { defaultConfig } from './init.js';

test('init writes a $schema pinned to the installed @juxtapose/core', () => {
  const { version } = JSON.parse(
    readFileSync(new URL('../../../core/package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  expect(
    defaultConfig({
      platform: { name: 'storybook' },
      buildDir: '/p/storybook-static',
      projectRoot: '/p',
    }),
  ).toEqual({
    $schema: `https://cdn.jsdelivr.net/npm/@juxtapose/core@${version}/schema.json`,
    platform: 'storybook',
    buildDir: 'storybook-static',
  });
});
