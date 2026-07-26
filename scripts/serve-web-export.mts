#!/usr/bin/env tsx
/**
 * CHUNK_3_IPC — a plain file server for the exported renderer, over loopback, for the BROWSER
 * Playwright project only.
 *
 * `next start` cannot serve a static export, so it is replaced here. This is a TEST harness and
 * nothing else: AP-Hub itself never opens a listening socket for the renderer — the shipped app
 * loads these same files off disk over `file:` (desktop/main.ts) and reaches the engine over the
 * sandboxed bridge.
 *
 * It reuses `desktop/renderer.ts` verbatim so the addresses resolve here exactly as they do in
 * the real window, placeholder detail pages included. Once `e2e/app.spec.ts` moves to the desktop
 * project this file and the `webServer` block in playwright.config.ts both go away.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { contentTypeFor, resolveExportedAddress } from '../desktop/renderer.js';

const OUT = join(process.cwd(), 'out');
const port = Number(process.argv[2] ?? 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('serve-web-export needs an unprivileged TCP port');
}

await stat(join(OUT, 'index.html')).catch(() => {
  throw new Error('out/ is missing — run `npm run web:build` first');
});

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const resolved = resolveExportedAddress(pathname, OUT, isFile);
  if (resolved === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  void readFile(resolved).then(
    (body) => {
      res.writeHead(200, { 'content-type': contentTypeFor(resolved) });
      res.end(body);
    },
    () => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unreadable');
    },
  );
}).listen(port, '127.0.0.1', () => {
  console.log(`exported renderer served on http://127.0.0.1:${port}`);
});
