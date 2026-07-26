import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  RENDERER_ID_ROUTES,
  RENDERER_ROUTE_SENTINEL,
  contentTypeFor,
  literalDiskPath,
  resolveExportedAddress,
  resolveRendererRequest,
} from '../desktop/renderer.js';

/**
 * CHUNK_3_IPC — the address rules for the exported renderer.
 *
 * `e2e-desktop/renderer.spec.ts` proves the consequence in a real Electron window. This proves the
 * rules themselves, including the two that are security-relevant and cannot be left to an
 * end-to-end test to notice: an address may never escape the exported tree, and a request that
 * names a file must never be answered with somebody else's page.
 */

const OUT = 'C:\\app\\out';
const p = (...parts: string[]): string => join(OUT, ...parts);

/** A fixed export, so the rules are tested rather than whatever happens to be built. */
const EXPORTED = new Set([
  p('index.html'),
  p('today.html'),
  p('login.html'),
  p('404.html'),
  p('statements.html'),
  p('statements', 'sentinel.html'),
  p('transactions', 'sentinel.html'),
  p('settings', 'tax-mapping', 'sentinel.html'),
  p('exceptions', 'tax.html'),
  p('_next', 'static', 'chunks', 'main.js'),
  p('_next', 'static', 'inline', 'abc123.js'),
]);
const isFile = (path: string): boolean => EXPORTED.has(path);

describe('literal disk paths are left alone', () => {
  it('recognises a Windows absolute address and converts it to a native path', () => {
    expect(literalDiskPath('/C:/app/dist-desktop/boot.html')).toBe(
      ['C:', 'app', 'dist-desktop', 'boot.html'].join(sep),
    );
  });

  it('treats a root-relative address as belonging to the exported renderer, not the disk', () => {
    expect(literalDiskPath('/_next/static/chunks/main.js')).toBeNull();
    expect(literalDiskPath('/statements/41')).toBeNull();
    expect(literalDiskPath('/')).toBeNull();
  });
});

describe('root-relative addresses resolve inside the exported renderer', () => {
  it('serves the exported index for the root', () => {
    expect(resolveExportedAddress('/', OUT, isFile)).toBe(p('index.html'));
  });

  it('serves a page by its address, with or without the file suffix', () => {
    expect(resolveExportedAddress('/today', OUT, isFile)).toBe(p('today.html'));
    expect(resolveExportedAddress('/today.html', OUT, isFile)).toBe(p('today.html'));
    expect(resolveExportedAddress('/exceptions/tax', OUT, isFile)).toBe(p('exceptions', 'tax.html'));
  });

  it('serves the scripts and styles the pages reference root-relatively', () => {
    // The whole reason the interception exists: off disk these would resolve to the drive root.
    expect(resolveExportedAddress('/_next/static/chunks/main.js', OUT, isFile)).toBe(
      p('_next', 'static', 'chunks', 'main.js'),
    );
    expect(resolveExportedAddress('/_next/static/inline/abc123.js', OUT, isFile)).toBe(
      p('_next', 'static', 'inline', 'abc123.js'),
    );
  });

  it('answers an unexported address as nothing rather than guessing', () => {
    expect(resolveExportedAddress('/nowhere', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/_next/static/chunks/absent.js', OUT, isFile)).toBeNull();
  });
});

describe('a record address is served its family placeholder page', () => {
  it('serves the placeholder for any id in each of the three families', () => {
    expect(resolveExportedAddress('/statements/424242', OUT, isFile)).toBe(p('statements', 'sentinel.html'));
    expect(resolveExportedAddress('/transactions/999123', OUT, isFile)).toBe(
      p('transactions', 'sentinel.html'),
    );
    expect(resolveExportedAddress('/settings/tax-mapping/919191', OUT, isFile)).toBe(
      p('settings', 'tax-mapping', 'sentinel.html'),
    );
  });

  it('never substitutes a page for a request that names a file', () => {
    // The page router asks for `<address>.txt` and must be told it is not there, or it will never
    // fall back to the full page load this whole scheme depends on.
    expect(resolveExportedAddress('/statements/424242.txt', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/transactions/999123.json', OUT, isFile)).toBeNull();
  });

  it('rewrites only the three declared families, never any other address', () => {
    expect(resolveExportedAddress('/exceptions/424242', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/settings/424242', OUT, isFile)).toBeNull();
    // Deeper than a single record segment is not a record address.
    expect(resolveExportedAddress('/statements/41/lines/7', OUT, isFile)).toBeNull();
  });
});

describe('an address can never escape the exported renderer', () => {
  it('refuses a parent-directory segment, plainly or encoded', () => {
    expect(resolveExportedAddress('/../secrets.txt', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/statements/../../secrets.txt', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/%2e%2e/secrets.txt', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/statements/%2E%2E%2F%2E%2E/secrets.txt', OUT, isFile)).toBeNull();
  });

  it('refuses a backslash or a NUL rather than normalising it', () => {
    expect(resolveExportedAddress('/..\\secrets.txt', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/statements%5C..%5Csecrets.txt', OUT, isFile)).toBeNull();
    expect(resolveExportedAddress('/today%00.html', OUT, isFile)).toBeNull();
  });

  it('refuses an address that cannot be decoded at all', () => {
    expect(resolveExportedAddress('/%E0%A4%A', OUT, isFile)).toBeNull();
  });
});

describe('the one decision the file handler makes', () => {
  it('serves an ordinary absolute path as itself', () => {
    const boot = ['C:', 'app', 'dist-desktop', 'boot.html'].join(sep);
    expect(resolveRendererRequest('/C:/app/dist-desktop/boot.html', OUT, (x) => x === boot)).toEqual({
      kind: 'disk',
      path: boot,
    });
  });

  it('reports a missing absolute path as missing, never re-rooted into the export', () => {
    // Re-rooting an absolute path would let any address reach any file under the export.
    expect(resolveRendererRequest('/C:/app/out/index.html', OUT, () => false)).toEqual({ kind: 'missing' });
  });

  it('resolves a root-relative address in the export', () => {
    expect(resolveRendererRequest('/statements/7', OUT, isFile)).toEqual({
      kind: 'exported',
      path: p('statements', 'sentinel.html'),
    });
  });

  it('answers everything as missing when no export has been built', () => {
    expect(resolveRendererRequest('/today', null, isFile)).toEqual({ kind: 'missing' });
  });
});

describe('content types', () => {
  it('names a type for everything the export and the boot page contain', () => {
    expect(contentTypeFor('a/b.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a/b.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a/b.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('a/b.txt')).toBe('text/plain; charset=utf-8');
  });

  it('does not guess for an unknown suffix', () => {
    expect(contentTypeFor('a/b.wat')).toBe('application/octet-stream');
    expect(contentTypeFor('a/b')).toBe('application/octet-stream');
  });
});

describe('the placeholder name agrees with the exported pages', () => {
  const ROOT = join(__dirname, '..');

  it('names the same placeholder here as each detail address declares', () => {
    // The three layouts cannot import this constant — a different build compiles them — so a
    // rename in either place has to fail here rather than produce a window that opens no record.
    for (const family of RENDERER_ID_ROUTES) {
      const layout = join(ROOT, 'app', '(app)', ...family.split('/'), '[id]', 'layout.tsx');
      expect(existsSync(layout)).toBe(true);
      const source = readFileSync(layout, 'utf8');
      expect(source).toContain('generateStaticParams');
      expect(source).toContain(`id: '${RENDERER_ROUTE_SENTINEL}'`);
    }
  });

  it('declares a family for every address that takes a record id, and no others', () => {
    // Found by walking the pages, so a fourth [id] address added later cannot quietly go unserved.
    const found: string[] = [];
    const walk = (dir: string, prefix: string[]): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === '[id]') found.push(prefix.join('/'));
        else walk(join(dir, entry.name), [...prefix, entry.name]);
      }
    };
    walk(join(ROOT, 'app', '(app)'), []);
    expect([...found].sort()).toEqual([...RENDERER_ID_ROUTES].sort());
  });
});

describe('the built export complies with the window script policy', () => {
  const OUT_DIR = join(__dirname, '..', 'out');
  const inline = /<script(?![^>]*\bsrc=)[^>]*>\s*\S[\s\S]*?<\/script>/;

  it('contains no inline script in any exported page', () => {
    // Only meaningful once the renderer has been exported; `npm run web:build` does that.
    if (!existsSync(join(OUT_DIR, 'index.html'))) return;
    const pages: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith('.html')) pages.push(join(dir, entry.name));
      }
    };
    walk(OUT_DIR);
    for (const page of pages) expect(readFileSync(page, 'utf8')).not.toMatch(inline);
  });

  it('exported a placeholder page for every record family', () => {
    if (!existsSync(join(OUT_DIR, 'index.html'))) return;
    for (const family of RENDERER_ID_ROUTES) {
      expect(existsSync(join(OUT_DIR, ...family.split('/'), `${RENDERER_ROUTE_SENTINEL}.html`))).toBe(true);
    }
  });
});
