import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch, stub, stubMe, OWNER } from './support/stub';

/**
 * CHUNK_7_BACKUP — the Settings backup panel driven through the real Electron app: a real
 * window, a real IPC bridge, a real renderer. `src/backup/*` and `src/backup/http.ts`'s own
 * logic is already proven at the unit/integration layer (`test/backup-*.test.ts`); what had NO
 * coverage anywhere was the one thing the spec's own most safety-critical bullet asks for —
 * "restore from the BookScout OS UI in one confirmation" — actually reachable and correct through the
 * real Settings panel, not just through calling `restoreBackup()` directly inside Vitest.
 *
 * Every `aphub:backup:*` channel is stubbed here (mirroring `settings.spec.ts`'s technique):
 * this file is about the PANEL's wiring and copy — that a click reaches the right channel with
 * the right payload and renders the right result — not a second copy of the backend's own tests.
 */

let app: ElectronApplication;
let win: Page;

const VERIFIED_BACKUP = {
  id: 1,
  kind: 'scheduled',
  createdAt: new Date().toISOString(),
  sizeBytes: 4_200_000,
  verifiedAt: new Date().toISOString(),
  externalCopy: null,
};

test.describe('Settings — backup panel', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('shows the most recent verified backup in plain language, and the list below it', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:backup:list', { ok: true, status: 200, data: [VERIFIED_BACKUP] });

    await win.goto('file:///settings');
    await expect(win.getByTestId('backup-latest')).toContainText('Most recent verified backup');
    await expect(win.getByTestId('backup-latest')).toContainText('checked and readable');
    await expect(win.getByTestId('backup-row-1')).toContainText('Checked and readable');
  });

  test('"Back up now" calls aphub:backup:create and shows the honest finished notice', async () => {
    await stub(app, 'aphub:backup:create', {
      ok: true,
      status: 200,
      data: { id: 2, verified: true, sizeBytes: 5_000_000 },
    });

    await win.getByTestId('backup-now').click();
    await expect(win.getByTestId('backup-notice')).toContainText('Backup finished and checked');
  });

  test('a failed "Back up now" never claims success', async () => {
    await stub(app, 'aphub:backup:create', {
      ok: false,
      status: 500,
      code: 'BACKUP_FAILED',
      message: 'BookScout OS made a backup copy but could not confirm it is readable. It was not counted.',
    });

    await win.getByTestId('backup-now').click();
    await expect(win.getByTestId('backup-notice')).toContainText('could not confirm it is readable');
    await expect(win.getByTestId('backup-notice')).not.toContainText('finished');
  });

  test('"Repair" calls aphub:backup:repair and reports success without claiming data changed', async () => {
    await stub(app, 'aphub:backup:repair', {
      ok: true,
      status: 200,
      data: { repaired: true, migrationsApplied: 0, backupKeyPresent: true },
    });

    await win.getByTestId('backup-repair').click();
    await expect(win.getByTestId('backup-notice')).toContainText('Repair finished');
    await expect(win.getByTestId('backup-notice')).toContainText('not changed');
  });

  test('destroy-and-restore drill: the one-confirmation UI gate blocks an unconfirmed restore, then restores', async () => {
    await stub(app, 'aphub:backup:restore', { ok: true, status: 200, data: { restored: true, rowCounts: { messages: 3 } } });

    await win.getByTestId('backup-restore-1').click();
    const confirmPanel = win.getByTestId('backup-restore-confirm');
    await expect(confirmPanel).toBeVisible();

    const confirmButton = win.getByTestId('backup-restore-confirm-button');
    await expect(confirmButton).toBeDisabled();

    // Checking the box alone is not enough — the button stays disabled until RESTORE is typed.
    await confirmPanel.locator('input[type="checkbox"]').check();
    await expect(confirmButton).toBeDisabled();

    await confirmPanel.locator('input[type="text"]').fill('RESTORE');
    await expect(confirmButton).toBeEnabled();

    await confirmButton.click();
    await expect(win.getByTestId('backup-notice')).toContainText('Restore complete');
    // The confirmation panel closes once the restore succeeds.
    await expect(win.getByTestId('backup-restore-confirm')).toHaveCount(0);
  });

  test('a failed restore leaves the current data claim untouched in the UI copy', async () => {
    await stub(app, 'aphub:backup:restore', {
      ok: false,
      status: 500,
      code: 'RESTORE_FAILED',
      message: 'BookScout OS could not restore that backup. Your current data was not changed.',
    });

    await win.getByTestId('backup-restore-1').click();
    const confirmPanel = win.getByTestId('backup-restore-confirm');
    await confirmPanel.locator('input[type="checkbox"]').check();
    await confirmPanel.locator('input[type="text"]').fill('RESTORE');
    await win.getByTestId('backup-restore-confirm-button').click();

    await expect(win.getByTestId('backup-notice')).toContainText('Your current data was not changed');
  });
});
