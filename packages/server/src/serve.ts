// Standalone server, for `jux serve` and for tests.
//
// The addon mounts `createRouter` directly into Storybook's dev server
// instead, which is why the router is separate from this.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRouter } from './router.js';
import type { ReviewSource } from './types.js';

export interface ServeHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function serve(source: ReviewSource, port = 0): Promise<ServeHandle> {
  const handler = createRouter(source);

  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });

  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
      }),
  };
}
