// THROWAWAY test harness for the static-export spike. NOT part of the product.
// Simulates what an Electron custom-protocol handler would do: serve a fixed
// sentinel HTML file for any runtime id path, while the browser's address bar
// keeps showing the real id, so we can check whether useParams() reads it.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = join(process.cwd(), 'out');

const SENTINEL_ROUTES = [
  { prefix: '/statements/', file: 'statements/sentinel.html' },
  { prefix: '/transactions/', file: 'transactions/sentinel.html' },
  { prefix: '/settings/tax-mapping/', file: 'settings/tax-mapping/sentinel.html' },
  { prefix: '/statements-catchall-test/', file: 'statements-catchall-test/sentinel.html' },
];

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Fake auth so SessionGuard (app/lib/session.tsx) doesn't redirect to /login during this test.
  if (url.pathname === '/api/me') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { email: 'spike@test.local', role: 'owner', tenantId: 1 } }));
    return;
  }
  const decodedPath = decodeURIComponent(url.pathname);
  const candidates = [join(ROOT, decodedPath), join(ROOT, decodedPath + '.html'), join(ROOT, decodedPath, 'index.html')];
  for (const filePath of candidates) {
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) continue;
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
      return;
    } catch {
      // try next candidate / fall through to sentinel matching
    }
  }
  // real static file with extension (e.g. sentinel.txt, .js chunks) already tried above.
  for (const r of SENTINEL_ROUTES) {
    if (url.pathname.startsWith(r.prefix) && url.pathname !== r.prefix) {
      const data = await readFile(join(ROOT, r.file));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
      return;
    }
  }
  res.writeHead(404);
  res.end('not found');
}).listen(4173, () => console.log('spike test server on http://localhost:4173'));
