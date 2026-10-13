// Verification 6: serves scripts/loop-anecdote/page.html — written from the
// corpus page on first run — re-read on every request, so an agent's edit
// to the file is live without a rebuild. PORT=4173 by default.
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOGO, render } from '../structural-corpus/page.mjs';

const file = path.join(import.meta.dirname, 'page.html');
if (!existsSync(file)) writeFileSync(file, render({}));
const port = Number(process.env.PORT ?? 4173);
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/logo-a.svg' || url.pathname === '/logo-b.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end(
      LOGO(url.pathname === '/logo-a.svg' ? 'rgb(37, 99, 235)' : 'rgb(220, 38, 38)'),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => {
  console.log(
    `serving ${file} at http://127.0.0.1:${port}/  (edit the file; no rebuild)`,
  );
});
