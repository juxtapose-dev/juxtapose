// packages/storybook/src/manager-imports.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Storybook's manager runs its own React and exposes only a fixed set of
// modules to addons as globals. Any other bare import is bundled from the
// *project's* node_modules, so a React 19 project drags its jsx-runtime into
// the manager's React 18 and the panel crashes (#198). Reads the built output
// (run `pnpm build` first, as CI does) and walks the manager entry's import graph.
const pkgDir = path.join(import.meta.dirname, '..');
const coreFormat = path.join(pkgDir, '../core/dist/report/format.js');

const ALLOWED = (spec: string): boolean =>
  spec === 'react' ||
  spec === 'react-dom' ||
  spec === 'react-dom/client' ||
  spec.startsWith('storybook/') ||
  // Plain TypeScript, no React; bundled by Storybook. Walked below.
  spec === '@juxtapose/core/format';

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const re =
    /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...src.matchAll(re)].map((m) => (m[1] ?? m[2] ?? m[3])!);
}

function walk(entry: string): { bare: Map<string, string>; files: string[] } {
  const bare = new Map<string, string>();
  const files: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
      else {
        if (!bare.has(spec)) bare.set(spec, path.relative(pkgDir, file));
        if (spec === '@juxtapose/core/format') queue.push(coreFormat);
      }
    }
  }
  return { bare, files };
}

describe('manager entry import graph', () => {
  const entry = path.join(pkgDir, 'dist/manager.js');

  it('imports only modules the Storybook manager provides', () => {
    expect(fs.existsSync(entry), 'run pnpm build first').toBe(true);
    const { bare, files } = walk(entry);
    expect(files.length).toBeGreaterThan(3);
    const offenders = [...bare]
      .filter(([spec]) => !ALLOWED(spec))
      .map(([spec, file]) => `${spec} (from ${file})`);
    expect(offenders).toEqual([]);
  });
});
