/**
 * CHUNK_3_IPC — where the window's addresses come from.
 *
 * The React tree ships as plain exported files under `out/`, loaded straight off disk. Two
 * properties of that export need a translation layer, and both are decided by the pure function
 * in this file so the gate can assert them without launching Electron:
 *
 *  1. The exported pages reference their scripts and styles by ROOT-RELATIVE address
 *     (`/_next/static/...`). Off disk that resolves to the root of the drive, where nothing
 *     lives. Every root-relative address is therefore resolved inside the exported tree instead.
 *
 *  2. Three addresses end in a record id that only exists once someone opens a record, so the
 *     export cannot name them at build time. One placeholder page is emitted per family
 *     (`out/statements/sentinel.html` and its two siblings) and served for ANY id in that family.
 *     The address in the window stays the real one, which is how the page recovers the id it was
 *     opened with — the baked-in placeholder is all the page's own routing would report.
 *
 * Nothing here relaxes a security control. This is the built-in `file:` scheme throughout, so the
 * navigation guard (`isAllowedNavigation`) still accepts `file:` and nothing else, and the window
 * keeps context isolation, the sandbox and the no-remote-origin policy exactly as CHUNK_1 set them.
 */

import { join, sep } from 'node:path';

/**
 * The placeholder id baked into each exported detail address.
 *
 * This value is also written literally in the three `app/(app)/**\/[id]/layout.tsx` files, which
 * cannot import from here (they are compiled by a different build). `test/desktop-renderer.test.ts`
 * asserts the two stay equal, so a rename in either place fails the gate instead of producing a
 * window that cannot open a statement.
 */
export const RENDERER_ROUTE_SENTINEL = 'sentinel';

/**
 * The address families whose last segment is a runtime record id. An explicit allowlist, not a
 * pattern: an address outside it is never rewritten to somebody else's page.
 */
export const RENDERER_ID_ROUTES: readonly string[] = [
  'statements',
  'transactions',
  'settings/tax-mapping',
];

/** Content types for everything the exported tree and the shell's own boot page contain. */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
});

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * A record id we are willing to serve a placeholder page for. Deliberately narrow: no dot, so a
 * request for `/statements/41.txt` — the page router asking for data, not for a page — falls
 * through and is correctly answered as missing rather than handed an HTML document.
 */
const RECORD_ID = /^[A-Za-z0-9_-]+$/;

/** Windows absolute form as it arrives in a `file:` address: `/C:/Users/...`. */
const DRIVE_ABSOLUTE = /^\/[A-Za-z]:\//;

/**
 * The literal on-disk path a `file:` address names, or null when the address is root-relative and
 * therefore belongs to the exported renderer rather than to the disk.
 */
export function literalDiskPath(pathname: string): string | null {
  if (!DRIVE_ABSOLUTE.test(pathname)) return null;
  return pathname.slice(1).split('/').join(sep);
}

/**
 * Resolve a root-relative address inside the exported renderer.
 *
 * Returns the absolute path of the file to serve, or null when the address names nothing — the
 * caller answers that as missing, which is what makes the page router fall back to a full page
 * load instead of waiting on data that will never arrive.
 *
 * `isFile` is injected so the whole decision is testable without a build on disk.
 */
export function resolveExportedAddress(
  pathname: string,
  outDir: string,
  isFile: (path: string) => boolean,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // A NUL or a backslash in an address is never legitimate here and both are classic ways to
  // smuggle a path apart. Refuse rather than normalise.
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const segments = decoded.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return null;

  const candidates =
    segments.length === 0
      ? ['index.html']
      : [segments.join('/'), `${segments.join('/')}.html`, `${segments.join('/')}/index.html`];

  for (const candidate of candidates) {
    const resolved = join(outDir, ...candidate.split('/'));
    if (isFile(resolved)) return resolved;
  }

  // Nothing is exported at this address. If it is a record inside one of the three id families,
  // its family's placeholder page is the right answer.
  if (segments.length >= 2) {
    const last = segments[segments.length - 1]!;
    const family = segments.slice(0, -1).join('/');
    if (RECORD_ID.test(last) && RENDERER_ID_ROUTES.includes(family)) {
      const placeholder = join(outDir, ...family.split('/'), `${RENDERER_ROUTE_SENTINEL}.html`);
      if (isFile(placeholder)) return placeholder;
    }
  }

  return null;
}

/**
 * The single decision the `file:` handler makes, for any address at all.
 *
 * `kind: 'exported'` — serve this file from the exported renderer.
 * `kind: 'disk'`     — an ordinary absolute path (the shell's own boot page); serve it as-is.
 * `kind: 'missing'`  — nothing is there.
 */
export type RendererResolution =
  | { kind: 'exported'; path: string }
  | { kind: 'disk'; path: string }
  | { kind: 'missing' };

export function resolveRendererRequest(
  pathname: string,
  outDir: string | null,
  isFile: (path: string) => boolean,
): RendererResolution {
  const literal = literalDiskPath(pathname);
  if (literal !== null) {
    return isFile(literal) ? { kind: 'disk', path: literal } : { kind: 'missing' };
  }
  if (outDir === null) return { kind: 'missing' };
  const exported = resolveExportedAddress(pathname, outDir, isFile);
  return exported === null ? { kind: 'missing' } : { kind: 'exported', path: exported };
}
