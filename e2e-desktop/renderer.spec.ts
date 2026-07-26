import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CHUNK_3_IPC — the exported renderer, and the addresses it is reached by, proved against a REAL
 * Electron process.
 *
 * `test/desktop-renderer.test.ts` asserts the rules. This asserts the consequence, and it is the
 * half that could not be taken on trust: the spike behind DEVIATIONS §5a proved the browser-side
 * behaviour through an HTTP stand-in and left the Electron wiring recorded as UNVERIFIED. Two
 * things only a real window could show turned up here and nowhere else — that the exported pages
 * carried inline scripts the window's script policy refuses (fixed by externalising them, never by
 * loosening the policy), and that `connect-src 'none'` stops the page router fetching its own data,
 * sending it down the full-page-load path this interception is what serves.
 *
 * The proof that matters is the last test: a detail address the export cannot possibly hold a page
 * for (`/statements/424242`) is answered with the one placeholder page that WAS exported, and the
 * page running inside it then asks the engine for record 424242 — not for the placeholder baked
 * into the document it was served from.
 */

const MAIN = join(process.cwd(), 'dist-desktop', 'main.mjs');
const OUT = join(process.cwd(), 'out');
const INLINE_DIR = join(OUT, '_next', 'static', 'inline');

/** Matches `RENDERER_ROUTE_SENTINEL` in desktop/renderer.ts and the three `[id]/layout.tsx`. */
const PLACEHOLDER = 'sentinel';

/**
 * Ids chosen to appear in no exported file, so a passing assertion cannot be explained away by the
 * export having happened to contain that address after all.
 */
const CASES = [
  { family: 'statements', id: '424242', channel: 'aphub:statements:get' },
  { family: 'transactions', id: '999123', channel: 'aphub:transactions:get' },
  { family: 'settings/tax-mapping', id: '919191', channel: 'aphub:tax-mappings:get' },
] as const;

const ALL_CHANNELS = CASES.map((c) => c.channel);

function placeholderHtml(family: string): string {
  return readFileSync(join(OUT, ...family.split('/'), `${PLACEHOLDER}.html`), 'utf8');
}

/** Every script a document loads, in document order. Identifies WHICH exported page it is. */
function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!);
}

/** A document plus everything it executes — the whole of what the browser could read an id from. */
function documentAndItsCode(family: string): string {
  const html = placeholderHtml(family);
  const inline = scriptSources(html)
    .filter((src) => src.includes('/static/inline/'))
    .map((src) => readFileSync(join(INLINE_DIR, src.split('/').pop()!), 'utf8'));
  return [html, ...inline].join('\n');
}

/** What the page asked for, per channel, as recorded by the stubs installed in the main process. */
function recorded(app: ElectronApplication, channel: string): Promise<unknown> {
  return app.evaluate(
    ({}, name: string) => (globalThis as { __seen?: Record<string, unknown> }).__seen?.[name] ?? null,
    channel,
  );
}

let app: ElectronApplication;
let win: Page;

test.describe('the exported renderer under a real Electron process', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    app = await electron.launch({ args: [MAIN] });
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    /**
     * Answer four channels FROM THE MAIN PROCESS, so the pages under test get past the sign-in
     * guard and reach their own data read. Local sign-in is CHUNK_4's, and without this the guard
     * would send every detail address to the sign-in screen before the page could ask for anything.
     *
     * This is the trusted side of the bridge standing in for itself — exactly as the browser suite
     * stubbed `/api/**` from outside the page. Nothing in the renderer is touched and nothing about
     * the bridge is relaxed: the sandbox, the context isolation and the frozen bridge are all still
     * in force, which is precisely why a recorded call can only be the page's own.
     */
    await app.evaluate(async ({ ipcMain }, { channels }: { channels: readonly string[] }) => {
      const store = globalThis as { __seen?: Record<string, unknown> };
      store.__seen = {};
      ipcMain.removeHandler('aphub:me:get');
      ipcMain.handle('aphub:me:get', () => ({
        ok: true,
        status: 200,
        data: { email: 'probe@example.test', role: 'owner_controller', tenantId: 1 },
      }));
      for (const channel of channels) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, payload: unknown) => {
          // Read through `globalThis` on every call, so a test that clears the record is obeyed.
          (store.__seen ??= {})[channel] = payload ?? {};
          // Answered as not-found deliberately: the page's REQUEST is the evidence, and inventing a
          // record would add a fixture nothing here depends on.
          return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Not found.' };
        });
      }
    }, { channels: ALL_CHANNELS });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the window opens the exported React tree, and its code actually runs', async () => {
    // Going to the root proves three things at once: the export was found rather than the shell's
    // own boot page, the document was served over the intercepted scheme, and its code ran — the
    // hop to Today is a decision the exported JavaScript makes, not anything the shell does.
    await win.goto('file:///');
    await expect.poll(() => win.url(), { timeout: 60_000, intervals: [250] }).toBe('file:///today');
    await expect(win.getByTestId('who')).toBeVisible();
  });

  test('no exported page carries an inline script, as the window policy requires', () => {
    // The invariant that lets `script-src 'self'` stay exactly as CHUNK_1 wrote it. Asserted across
    // every exported page, because one missed page is a blank window rather than a subtle
    // regression, and a real window proved that is exactly how it fails.
    const inline = /<script(?![^>]*\bsrc=)[^>]*>\s*\S[\s\S]*?<\/script>/;
    const pages: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith('.html')) pages.push(join(dir, entry.name));
      }
    };
    walk(OUT);
    expect(pages.length).toBeGreaterThanOrEqual(16);
    for (const page of pages) expect(readFileSync(page, 'utf8')).not.toMatch(inline);
  });

  test('a data address with no page behind it is answered as missing, not substituted', async () => {
    // The page router asks for `<address>.txt` before falling back to a full page load. Handing it
    // a document instead of a not-found would break that fallback, which is the mechanism the whole
    // scheme depends on.
    const rsc = await win.goto('file:///statements/424242.txt');
    expect(rsc?.status()).toBe(404);
  });

  for (const { family, id, channel } of CASES) {
    test(`/${family}/<id> serves the exported placeholder page and resolves the real id`, async () => {
      // Forget what earlier addresses asked for, so this test can also show that nothing but this
      // family's own page ran.
      await app.evaluate(({}) => {
        (globalThis as { __seen?: Record<string, unknown> }).__seen = {};
      });

      const served = await win.goto(`file:///${family}/${id}`);
      await win.waitForLoadState('domcontentloaded');

      // Answered, not missing — for an address the export holds no page for.
      expect(served?.status()).toBe(200);

      // The address is untouched. This is the only place the real id survives.
      expect(win.url()).toBe(`file:///${family}/${id}`);

      // The discriminating fact, and the reason the id cannot have come from the document: the
      // placeholder is the only id the export could know at build time, so the document and every
      // line of code it loads name the placeholder and never the id the person opened.
      const documentAndCode = documentAndItsCode(family);
      expect(documentAndCode).toContain(PLACEHOLDER);
      expect(documentAndCode).not.toContain(id);

      /**
       * The proof, in one observation. Only this family's detail page reads this channel, so a
       * recorded call means the placeholder document really did run THIS page — and the id on the
       * call means the page resolved the address it was opened at, not the placeholder baked into it.
       */
      await expect
        .poll(() => recorded(app, channel), { timeout: 30_000, intervals: [250] })
        .not.toBeNull();
      const payload = (await recorded(app, channel)) as { id?: unknown };
      expect(String(payload.id)).toBe(id);
      expect(String(payload.id)).not.toBe(PLACEHOLDER);

      // Nothing else ran: no other detail page was rendered by this one address.
      for (const other of ALL_CHANNELS.filter((c) => c !== channel)) {
        expect(await recorded(app, other)).toBeNull();
      }
    });
  }
});
