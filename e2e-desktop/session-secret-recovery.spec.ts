import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeElectron,
  isolatedLocalAppData,
  isolatedUserDataDir,
  launchElectron,
} from './support/electron-lifecycle';

/**
 * CHUNK_4_IDENTITY — regression test for a real defect caught during integration verification.
 *
 * `desktop/local-signin.ts`'s `ensureSessionCookieSecret` originally skipped generating a real
 * secret whenever `process.env.SESSION_COOKIE_SECRET` was merely truthy, not merely long enough.
 * A short pre-existing value (this repo's own dev `.env` carries `SESSION_COOKIE_SECRET=
 * dev-only-change-me`, 18 characters) was silently accepted as "already set," so the credential-
 * store-backed secret was never generated, and `config()`'s `min(32)` schema validation later
 * failed deep inside session creation — surfacing as an opaque "database did not start" failure
 * that had nothing to do with the database. Fixed by checking length, not just presence.
 *
 * This test launches the real Electron main process with a deliberately too-short
 * `SESSION_COOKIE_SECRET` forced into its environment, independent of whatever this checkout's
 * own `.env` happens to contain, so the regression is caught even in a clean environment that
 * never had the original triggering `.env` value.
 *
 * Harness notes: each run uses an isolated Electron user-data profile and `%LOCALAPPDATA%` root
 * under `test-results/` so it never contends with the product install or a prior launch that has
 * not yet released `requestSingleInstanceLock()`. Teardown waits for the main process to exit
 * after `close()` — see `support/electron-lifecycle.ts`.
 */

const MAIN = join(process.cwd(), 'dist-desktop', 'main.mjs');
const BUNDLE_PRESENT = existsSync(join(process.cwd(), 'vendor', 'pgsql', 'bin', 'initdb.exe'));
const SPEC = 'session-secret-recovery';
const LOCAL_APPDATA = isolatedLocalAppData(SPEC);
const USER_DATA = isolatedUserDataDir(SPEC);

interface ShellStatus {
  ok: boolean;
  data: { engine: string; label: string; database: string; problem: string | null };
}

let app: ElectronApplication;
let win: Page;

test.describe('a too-short pre-existing SESSION_COOKIE_SECRET is overwritten, not trusted', () => {
  test.skip(!BUNDLE_PRESENT, 'vendor/pgsql absent — run: node scripts/bundle-postgres.mjs');
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    app = await launchElectron({
      args: [MAIN],
      userDataDir: USER_DATA,
      env: {
        ...process.env,
        LOCALAPPDATA: LOCAL_APPDATA,
        SESSION_COOKIE_SECRET: 'too-short',
      },
    });
    app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on('data', (d) => process.stdout.write(`[main:err] ${d}`));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await closeElectron(app);
  });

  test('the shell still reaches "running" — the short value is replaced, not accepted', async () => {
    const status = await expect
      .poll(
        async () => {
          const res = (await win.evaluate(() =>
            (window as unknown as { aphub: { invoke: (c: string) => Promise<ShellStatus> } }).aphub.invoke(
              'aphub:shell:status',
            ),
          )) as ShellStatus;
          return res.data;
        },
        { timeout: 200_000, intervals: [1000] },
      )
      .toMatchObject({ engine: 'running', database: 'ready' })
      .then(() =>
        win.evaluate(() =>
          (window as unknown as { aphub: { invoke: (c: string) => Promise<ShellStatus> } }).aphub.invoke(
            'aphub:shell:status',
          ),
        ),
      );

    expect((status as ShellStatus).data.problem).toBeNull();
  });
});
