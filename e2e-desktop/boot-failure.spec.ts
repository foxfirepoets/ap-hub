import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CHUNK_3_IPC — what the person sees when the private database does NOT come up.
 *
 * This is the case CHUNK_2's startup screen was built for, and until now nothing proved it end to
 * end: `database.spec.ts` proves the happy path, and the failure copy was covered only as a pure
 * function. The gap mattered the moment CHUNK_3 gave the window somewhere else to go — a shell that
 * hands over to the app regardless would show a working-looking product with no information in it
 * and no explanation, which is precisely the dead end the boot screen removed.
 *
 * The failure is caused, not simulated. A copy of the built shell is staged in a directory that has
 * no bundled PostgreSQL beside it, so `resourceRoot()` resolves to a tree where `initdb` genuinely
 * does not exist and the real supervisor fails for the real reason. It is staged INSIDE the
 * repository so the external packages the main process leaves unbundled still resolve, and it is
 * given a copy of the exported app as well — otherwise "the app did not appear" would prove nothing
 * more than that there was no app to appear.
 *
 * Nothing on disk is disturbed: `startLocalDatabase` reaches the missing executable at step 3, long
 * before it writes an install file at step 6 (`src/db/local-database.ts:184-244`).
 */

const ROOT = process.cwd();
// Under test-results/, which is already ignored and already written to by Playwright.
const STAGE = join(ROOT, 'test-results', 'aphub-startup-failure');
const STAGED_MAIN = join(STAGE, 'dist-desktop', 'main.mjs');

/** Verbatim `describeDatabaseFailure`'s generic branch (desktop/database.ts:84-90). */
const EXPECTED_PROBLEM =
  'AP-Hub could not start its private database. Restarting AP-Hub usually fixes this. ' +
  'If it keeps happening, use Repair in Settings.';

interface ShellStatus {
  ok: boolean;
  data: { engine: string; label: string; database: string; problem: string | null };
}

let app: ElectronApplication;
let win: Page;

test.describe('a database that will not start', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });
    cpSync(join(ROOT, 'dist-desktop'), join(STAGE, 'dist-desktop'), { recursive: true });
    // The exported app IS present here. Its absence must not be the reason it stays hidden.
    if (existsSync(join(ROOT, 'out'))) cpSync(join(ROOT, 'out'), join(STAGE, 'out'), { recursive: true });
    expect(existsSync(join(STAGE, 'pgsql', 'bin', 'initdb.exe'))).toBe(false);

    app = await electron.launch({ args: [STAGED_MAIN] });
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(STAGE, { recursive: true, force: true });
  });

  test('the startup screen says what went wrong, in a sentence with a next action', async () => {
    await expect(win.locator('#boot-heading')).toHaveText('AP-Hub could not finish starting.', {
      timeout: 60_000,
    });
    await expect(win.locator('#boot-detail')).toHaveText(EXPECTED_PROBLEM);
    // The progress bar must stop: a bar still crawling says "wait longer", which is a lie here.
    await expect(win.locator('#boot-bar')).toBeHidden();
  });

  test('nothing technical reaches the screen', async () => {
    const shown = await win.evaluate(() => document.body.innerText);
    // The person is non-technical. No path, no port, no executable, no code, no stack trace.
    for (const forbidden of [
      'initdb',
      'postgres',
      'PostgreSQL',
      'pgsql',
      'Error',
      'ENOENT',
      'DB_FAILED',
      'undefined',
      'C:\\',
      '.exe',
    ]) {
      expect(shown).not.toContain(forbidden);
    }
    expect(shown).not.toMatch(/\b(?:5[0-9]{4}|localhost|127\.0\.0\.1)\b/);
  });

  test('the shell reports the failure over the bridge in the same plain language', async () => {
    const status = (await win.evaluate(() =>
      (window as unknown as { aphub: { invoke: (c: string) => Promise<ShellStatus> } }).aphub.invoke(
        'aphub:shell:status',
      ),
    )) as ShellStatus;
    expect(status.data.engine).toBe('unstable');
    expect(status.data.database).toBe('unavailable');
    expect(status.data.problem).toBe(EXPECTED_PROBLEM);
    expect(status.data.label).toBe('AP-Hub is having trouble starting. Your information is safe.');
  });

  test('the window never hands over to the app, so the explanation is not replaced', async () => {
    /**
     * The regression this file exists to prevent. The hand-over is scheduled only on `running`, so a
     * failed start must leave the person on the explanation indefinitely — waited out past the ready
     * beat with a wide margin, then checked again, because a hand-over scheduled in error would fire
     * once and be gone.
     */
    await win.waitForTimeout(9_000);
    expect(win.url()).toContain('boot.html');
    await expect(win.locator('#boot-heading')).toHaveText('AP-Hub could not finish starting.');
    await expect(win.locator('#boot-detail')).toHaveText(EXPECTED_PROBLEM);
  });
});
