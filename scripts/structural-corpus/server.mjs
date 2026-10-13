// Serves the corpus page on a random port: GET /op/<name> renders that
// operator's page; two logos exist so an `src` swap changes real pixels.
import { createServer } from 'node:http';
import { LOGO, pageHtml } from './page.mjs';

export function startCorpusServer() {
  // path name -> operator actually rendered, so a check can change what one
  // URL serves between a "before" and an "after" snap (the edit an agent makes).
  const overrides = new Map();
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/logo-a.svg' || url.pathname === '/logo-b.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end(
          LOGO(url.pathname === '/logo-a.svg' ? 'rgb(37, 99, 235)' : 'rgb(220, 38, 38)'),
        );
        return;
      }
      // Operators live in the PATH, not the query: `jux snap` names a snap by
      // a slug of host + path and drops the query, so `/?op=a` and `/?op=b`
      // would collide on one file.
      const m = /^\/op\/([a-z-]+)$/.exec(url.pathname);
      try {
        if (!m) throw new Error(`not found: ${url.pathname}`);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(pageHtml(overrides.get(m[1]) ?? m[1]));
      } catch (e) {
        res.writeHead(404);
        res.end(e.message);
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
        serveAs: (name, operator) => overrides.set(name, operator),
      });
    });
  });
}
