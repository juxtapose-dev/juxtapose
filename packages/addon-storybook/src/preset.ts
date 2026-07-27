// Node-side preset: mount the review API inside Storybook's own dev server.
//
// Same origin as the preview, so there is no CORS to configure, no second
// port to remember, and no separate process to start. The addon works because
// you added it, not because you also ran something.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRouter, RunDirSource } from '@juxtapose/server';
import { GitBaselineStore, type ProjectConfig } from '@juxtapose/core';
import { StorybookPlatform } from '@juxtapose/adapter-storybook';

interface ViteDevServer {
  middlewares: {
    use(fn: (req: unknown, res: unknown, next: () => void) => void): void;
  };
  config?: { server?: { port?: number } };
}

interface VitePlugin {
  name: string;
  configureServer(server: ViteDevServer): void;
}

interface ViteConfig {
  plugins?: unknown[];
  [key: string]: unknown;
}

export function viteFinal(config: ViteConfig): ViteConfig {
  return {
    ...config,
    plugins: [...(config.plugins ?? []), juxtaposePlugin()],
  };
}

function juxtaposePlugin(): VitePlugin {
  const projectRoot = process.env.JUXTAPOSE_ROOT ?? process.cwd();
  const config = loadConfig(projectRoot);

  const source = new RunDirSource({
    projectRoot,
    platform: new StorybookPlatform(),
    store: new GitBaselineStore({ projectRoot }),
    config,
    // Replaced per-request from the Host header, since the dev server's port
    // is chosen by Storybook and can shift between sessions.
    baseUrl: 'http://localhost:6006',
    runDir: path.join(projectRoot, '.juxtapose', 'runs', 'dev'),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot) ?? 'unknown',
    commitSha: git(['rev-parse', 'HEAD'], projectRoot) ?? 'unknown',
  });

  const handler = createRouter(source);

  return {
    name: 'juxtapose',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const request = req as { headers?: Record<string, string | undefined> };
        const host = request.headers?.host;
        if (host) source.setBaseUrl(`http://${host}`);

        void handler(
          req as Parameters<typeof handler>[0],
          res as Parameters<typeof handler>[1],
        ).then((handled) => {
          if (!handled) next();
        });
      });
    },
  };
}

function loadConfig(projectRoot: string): ProjectConfig {
  for (const name of ['juxtapose.config.json', '.juxtaposerc.json']) {
    try {
      // Synchronous on purpose: this runs once at dev-server startup, and
      // making the plugin factory async would complicate Storybook's config
      // loading for no benefit.
      return JSON.parse(
        readFileSync(path.join(projectRoot, name), 'utf8'),
      ) as ProjectConfig;
    } catch {
      // try the next candidate
    }
  }
  return {};
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
