import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { McpServer } from './mcp.js';

const roots: string[] = [];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4TyJgGNVABCA5lADspH6QblB3gwAAAABJRU5ErkJggg==',
  'base64',
);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-target-only-'));
  roots.push(root);
  await writeFile(path.join(root, 'target.png'), png);
  const config = {
    designReferences: {
      desktop: {
        storyId: 'card',
        image: 'target.png',
        viewport: { width: 12, height: 8 },
      },
    },
  };
  await writeFile(path.join(root, 'juxtapose.config.json'), JSON.stringify(config));
  return {
    root,
    config,
    server: new McpServer({ project: root, chrome: '/must-not-launch' }),
  };
}
test('reads target before any run without browser, comparison or generated artifacts', async () => {
  const { root, server } = await fixture();
  try {
    const before = await readdir(root);
    const result = await server.call('reference', { name: 'desktop', detail: 'target' });
    expect(result.isError).toBe(false);
    const text = result.content.find((c) => c.type === 'text');
    const image = result.content.find((c) => c.type === 'image');
    expect(text?.type === 'text' && JSON.parse(text.text)).toMatchObject({
      schema: 'juxtapose.design-target/v1',
      name: 'desktop',
      pixels: { width: 12, height: 8 },
    });
    expect(image?.type === 'image' && Buffer.from(image.data, 'base64')).toEqual(png);
    expect(await readdir(root)).toEqual(before);
  } finally {
    await server.close();
  }
});
test('requires an explicit configured target and rejects comparison-only arguments', async () => {
  const { server } = await fixture();
  try {
    for (const args of [
      { detail: 'target' },
      { detail: 'target', name: 'missing' },
      { detail: 'target', name: 'desktop', region: 'r1' },
      { detail: 'target', name: 'desktop', compare: 'previous', fromRun: 'old' },
    ]) {
      expect((await server.call('reference', args)).isError).toBe(true);
    }
  } finally {
    await server.close();
  }
});
test('rejects references escaping the project through symlinks', async () => {
  const { root, config, server } = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'jux-target-outside-'));
  roots.push(outside);
  await writeFile(path.join(outside, 'private.png'), png);
  await symlink(path.join(outside, 'private.png'), path.join(root, 'escape.png'));
  config.designReferences.desktop.image = 'escape.png';
  await writeFile(path.join(root, 'juxtapose.config.json'), JSON.stringify(config));
  try {
    expect(
      (await server.call('reference', { name: 'desktop', detail: 'target' })).isError,
    ).toBe(true);
  } finally {
    await server.close();
  }
});
