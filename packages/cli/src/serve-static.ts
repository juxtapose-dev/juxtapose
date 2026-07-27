// Minimal static server for a built workbench.
//
// Exists so `jux run` needs no separate serve step. The one thing it does that
// a naive server wouldn't: mark content-addressed assets immutable, so
// Chromium serves the bundle from memory across all N contexts instead of
// re-fetching it per context.

import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Hashed-filename assets never change under the same name. */
const IMMUTABLE = new Set([
  '.js',
  '.mjs',
  '.css',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
]);

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

export async function serveStatic(dir: string): Promise<StaticServer> {
  const root = resolve(dir);

  const server: Server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(root, rel);

    // Never serve outside the build directory, whatever the request says.
    if (!filePath.startsWith(root + sep) && filePath !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }

    void (async () => {
      try {
        let info = await stat(filePath);
        if (info.isDirectory()) {
          filePath = join(filePath, 'index.html');
          info = await stat(filePath);
        }

        const ext = extname(filePath);
        res.writeHead(200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'content-length': info.size,
          'cache-control': IMMUTABLE.has(ext)
            ? 'public, max-age=31536000, immutable'
            : 'no-store',
        });
        createReadStream(filePath).pipe(res);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
      }),
  };
}
