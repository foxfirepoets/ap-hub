import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch, stub, stubMe, stubThrow, OWNER, BOOKKEEPER, CPA } from './support/stub';

/**
 * CHUNK_3_IPC migration of `e2e/app.spec.ts` — bank-statement review journeys (5 of the 24
 * browser-era journeys).
 */

const STATEMENT_LIST = [
  {
    id: 71,
    institutionName: 'Community Bank',
    accountHint: '…7788',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    status: 'review',
    filedAt: null,
    lineCount: 2,
    unresolvedCount: 2,
  },
];

const STATEMENT_DETAIL = {
  ...STATEMENT_LIST[0]!,
  documentId: 301,
  currency: 'USD',
  openingBalance: '1000.00',
  closingBalance: '930.00',
  validationDetail: { equation: '1000.00 + -70.00 = 930.00', valid: true },
  lines: [
    {
      id: 801,
      lineNo: 1,
      postedOn: '2026-06-02',
      description: 'Office rent',
      amount: '-50.00',
      balance: '950.00',
      matchStatus: 'unmatched',
      matchedProviderRef: null,
      reviewReason: null,
    },
    {
      id: 802,
      lineNo: 2,
      postedOn: '2026-06-03',
      description: 'Bank fee',
      amount: '-20.00',
      balance: '930.00',
      matchStatus: 'unmatched',
      matchedProviderRef: null,
      reviewReason: null,
    },
  ],
};

let app: ElectronApplication;
let win: Page;

test.describe('Bank statement review', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('owner reviews, matches, excludes, and files statement evidence', async () => {
    await stubMe(app, OWNER);

    await app.evaluate(
      ({ ipcMain }, seed: { list: unknown; detail: Record<string, unknown> & { lines: Record<string, unknown>[] } }) => {
        const current = JSON.parse(JSON.stringify(seed.detail)) as typeof seed.detail;
        for (const channel of [
          'aphub:statements:list',
          'aphub:statements:get',
          'aphub:statements:match-line',
          'aphub:statements:exclude-line',
          'aphub:statements:file',
        ]) {
          ipcMain.removeHandler(channel);
        }
        ipcMain.handle('aphub:statements:list', () => ({ ok: true, status: 200, data: seed.list }));
        ipcMain.handle('aphub:statements:get', () => ({ ok: true, status: 200, data: current }));
        ipcMain.handle('aphub:statements:match-line', () => {
          (current.lines[0] as Record<string, unknown>).matchStatus = 'matched';
          current.unresolvedCount = 1;
          return { ok: true, status: 200, data: { ok: true } };
        });
        ipcMain.handle('aphub:statements:exclude-line', () => {
          (current.lines[1] as Record<string, unknown>).matchStatus = 'excluded';
          current.unresolvedCount = 0;
          return { ok: true, status: 200, data: { ok: true } };
        });
        ipcMain.handle('aphub:statements:file', () => ({ ok: true, status: 200, data: { ok: true } }));
      },
      { list: STATEMENT_LIST, detail: STATEMENT_DETAIL },
    );

    await win.goto('file:///statements');
    await expect(win.getByTestId('statement-row-71')).toContainText('2 unresolved');
    await win.getByTestId('statement-row-71').getByRole('link', { name: 'Review' }).click();
    await expect(win.getByTestId('statement-detail-page')).toContainText('Source evidence');
    await win.getByLabel('Reason for line 1').fill('Matched to rent bill');
    await win.getByLabel('Provider reference for line 1').fill('bill-500');
    await win.getByTestId('statement-line-801').getByRole('button', { name: 'Match' }).click();
    await expect(win.getByTestId('statement-notice')).toContainText('saved');
    await win.getByLabel('Reason for line 2').fill('Reviewed bank service charge');
    await win.getByTestId('statement-line-802').getByRole('button', { name: 'Exclude' }).click();
    await expect(win.getByTestId('statement-file')).toBeEnabled();
    await win.getByTestId('statement-file').click();
    await expect(win.getByTestId('statement-notice')).toContainText('saved');
  });

  test('bookkeeper may review statements; CPA sees evidence read-only', async () => {
    await stub(app, 'aphub:statements:list', { ok: true, status: 200, data: STATEMENT_LIST });
    await stub(app, 'aphub:statements:get', { ok: true, status: 200, data: STATEMENT_DETAIL });

    await stubMe(app, BOOKKEEPER);
    await win.goto('file:///statements/71');
    await expect(win.getByTestId('statement-line-801').getByRole('button', { name: 'Match' })).toBeVisible();
    await expect(win.getByTestId('statement-file')).toBeVisible();

    await stubMe(app, CPA);
    await win.goto('file:///statements/71');
    await expect(win.getByTestId('statement-readonly')).toBeVisible();
    await expect(win.getByRole('button', { name: 'Match' })).toHaveCount(0);
    await expect(win.getByTestId('statement-file')).toHaveCount(0);
  });

  test('held statement exposes validation evidence and correction recovery but cannot be filed', async () => {
    await stubMe(app, OWNER);
    const held = {
      ...STATEMENT_DETAIL,
      status: 'unbalanced',
      validationDetail: { equation: '1000.00 + -70.00 != 950.00', difference: '20.00' },
    };
    await stub(app, 'aphub:statements:list', { ok: true, status: 200, data: STATEMENT_LIST });
    await stub(app, 'aphub:statements:get', { ok: true, status: 200, data: held });

    await win.goto('file:///statements/71');
    await expect(win.getByTestId('statement-held')).toContainText('difference');
    await expect(win.getByRole('button', { name: 'Save correction' })).toBeVisible();
    await expect(win.getByTestId('statement-file')).toBeDisabled();
  });

  test('statement navigation fails closed for anonymous and foreign-tenant records', async () => {
    await stubMe(app, null);
    await win.goto('file:///statements/71');
    await expect.poll(() => win.url()).toMatch(/\/login$/);

    await stubMe(app, OWNER);
    await stub(app, 'aphub:statements:get', { ok: true, status: 200, data: null });
    await win.goto('file:///statements/999');
    await expect(win.getByTestId('statement-not-found')).toContainText('not found or unavailable in this company');
    await expect(win.getByTestId('statement-not-found')).not.toContainText('tenant');
  });

  test('statement mutation network failure recovers controls and gives a retryable message', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:statements:list', { ok: true, status: 200, data: STATEMENT_LIST });
    await stub(app, 'aphub:statements:get', { ok: true, status: 200, data: STATEMENT_DETAIL });
    await stubThrow(app, 'aphub:statements:match-line');

    await win.goto('file:///statements/71');
    await win.getByLabel('Reason for line 1').fill('Matched after review');
    await win.getByLabel('Provider reference for line 1').fill('bill-500');
    const match = win.getByTestId('statement-line-801').getByRole('button', { name: 'Match' });
    await match.click();
    await expect(win.getByTestId('statement-notice')).toContainText('try again', { ignoreCase: true });
    await expect(match).toBeEnabled();
  });
});
