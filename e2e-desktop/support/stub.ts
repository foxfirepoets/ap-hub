import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * CHUNK_3_IPC migration support — shared helpers for the journeys moved out of
 * `e2e/app.spec.ts` (browser + `page.route` HTTP mocks) into `e2e-desktop/**` (real Electron
 * process + real `ipcMain` channel overrides). `window.aphub.invoke` is the renderer's only
 * transport now (no `fetch`, no HTTP), so the fixture mechanism moves from `page.route`
 * intercepting requests to overriding specific `desktop/ipc/**` channel handlers directly on
 * the real `ipcMain` inside the Electron main process — the same technique already
 * established in `e2e-desktop/renderer.spec.ts`. The real dispatcher
 * (`desktop/ipc/dispatcher.ts`) stays registered, and still answers, for every channel a test
 * does not override.
 */

export const MAIN = join(process.cwd(), 'dist-desktop', 'main.mjs');

export interface Me {
  email: string;
  role: string;
  tenantId: number;
}

export const OWNER: Me = { email: 'owner@example.com', role: 'owner_controller', tenantId: 1 };
export const BOOKKEEPER: Me = { email: 'book@example.com', role: 'bookkeeper', tenantId: 1 };
export const CPA: Me = { email: 'cpa@example.com', role: 'cpa', tenantId: 1 };

export async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [MAIN] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

/**
 * Override one IPC channel's handler for the lifetime of the app (or until re-stubbed).
 * Mirrors `renderer.spec.ts`'s `ipcMain.removeHandler` + `ipcMain.handle` pattern exactly —
 * the integration lead's explicit instruction for replacing `page.route`.
 */
export async function stub(app: ElectronApplication, channel: string, response: unknown): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, args: { channel: string; response: unknown }) => {
      ipcMain.removeHandler(args.channel);
      ipcMain.handle(args.channel, () => args.response);
    },
    { channel, response },
  );
}

/** The session gate every page resolves via `aphub:me:get` (SessionGuard, app/lib/session.tsx). */
export async function stubMe(app: ElectronApplication, me: Me | null): Promise<void> {
  await stub(
    app,
    'aphub:me:get',
    me
      ? { ok: true, status: 200, data: me }
      : { ok: false, status: 401, code: 'UNAUTHENTICATED', message: 'no session' },
  );
}

/**
 * Fail an IPC channel the way a `page.route(...).abort('connectionfailed')` used to fail a
 * fetch: `ipcRenderer.invoke` rejects, so `app/lib/api.ts`'s callers land in their `catch`
 * branch with a non-`ApiError` cause, exactly as the browser-era network-failure tests relied
 * on.
 */
export async function stubThrow(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, ch: string) => {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, () => {
      throw new Error('simulated network failure');
    });
  }, channel);
}

/**
 * `shell.spec.ts:94`'s no-network-request pattern, reused so every migrated file can prove the
 * renderer never issues an HTTP/loopback request while these journeys run.
 */
export function trackHttpRequests(win: Page): string[] {
  const requests: string[] = [];
  win.on('request', (r) => {
    const url = r.url();
    if (url.startsWith('http://') || url.startsWith('https://')) requests.push(url);
  });
  return requests;
}
