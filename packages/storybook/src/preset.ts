// Node-side preset: mount the review API inside Storybook's own dev server.
//
// Same origin as the preview, so there is no CORS to configure, no second
// port to remember, and no separate process to start. The addon works because
// you added it, not because you also ran something.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, RunDirSource } from '@juxtapose/server';
import { createBaselineStore, type ProjectConfig } from '@juxtapose/core';
import { juxtaposeModuleGraph } from '@juxtapose/core/vite';
import { StorybookPlatform } from '@juxtapose/adapter-storybook';

// Vite's connect middlewares receive Node's own request and response (its
// Connect.IncomingMessage extends http.IncomingMessage), declared here so the
// addon does not depend on vite's types.
interface ViteDevServer {
  middlewares: {
    use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void;
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
    // The module graph plugin only acts in `storybook build`; the dev-server
    // plugin only in `storybook dev`. Both are added in both: each is inert in
    // the other's mode.
    plugins: [...(config.plugins ?? []), juxtaposePlugin(), juxtaposeModuleGraph()],
  };
}

function juxtaposePlugin(): VitePlugin {
  const projectRoot = process.env.JUXTAPOSE_ROOT ?? process.cwd();
  const config = loadConfig(projectRoot);

  let store;
  try {
    // s3 is refused by the CLI; the panel falls back to the default store
    // rather than failing to mount.
    store = createBaselineStore(
      projectRoot,
      config.storage?.kind === 's3' ? undefined : config.storage,
    );
  } catch (err) {
    // A bad storage.dir must not take Storybook's dev server down with it:
    // say why and leave the panel's API unmounted.
    console.warn(
      `[juxtapose] capture disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { name: 'juxtapose', configureServer() {} };
  }

  const source = new RunDirSource({
    projectRoot,
    platform: new StorybookPlatform(),
    store,
    config,
    // Replaced per-request from the Host header, since the dev server's port
    // is chosen by Storybook and can shift between sessions.
    baseUrl: 'http://localhost:6006',
    runDir: path.join(projectRoot, '.juxtapose', 'runs', 'dev'),
    // A previous `storybook build`, if the developer happens to have one. The
    // dev server has no bundler graph, so this is the only way watch mode can
    // widen "this component changed" to "and here is what imports it". Stale
    // or absent is fine — it only ever narrows what we recapture, and the
    // fallback is the component's own stories.
    buildDir: path.join(projectRoot, 'storybook-static'),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot) ?? 'unknown',
    commitSha: git(['rev-parse', 'HEAD'], projectRoot) ?? 'unknown',
  });

  const handler = createRouter(source);

  return {
    name: 'juxtapose',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = req.headers.host;
        if (host) source.setBaseUrl(`http://${host}`);

        void handler(req, res).then((handled) => {
          if (!handled) next();
        });
      });
    },
  };
}

function loadConfig(projectRoot: string): ProjectConfig {
  for (const name of ['juxtapose.config.json', '.juxtaposerc.json']) {
    try {
      // As the CLI's loadConfig: settings are checked where they are used.
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
