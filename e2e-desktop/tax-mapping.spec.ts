import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch, stub, stubMe, OWNER, BOOKKEEPER } from './support/stub';

/**
 * CHUNK_3_IPC migration of `e2e/app.spec.ts` — F_TAX_MAPPING UI journeys (4 of the 24
 * browser-era journeys): settings/tax-mapping, settings/tax-mapping/[id], exceptions/tax.
 */

const TAX_MAPPING_ACTIVE = {
  id: 1,
  connection_id: 10,
  provider: 'qbo',
  provider_tax_code: 'TAX8',
  internal_tax_treatment: 'standard_sales_tax',
  tax_mode: 'exclusive',
  applies_at: 'invoice',
  active: true,
  needs_revalidation: false,
  superseded_by_id: null,
  replaced_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const TAX_MAPPING_STALE = { ...TAX_MAPPING_ACTIVE, id: 2, provider_tax_code: 'TAX9', needs_revalidation: true };

let app: ElectronApplication;
let win: Page;

test.describe('F_TAX_MAPPING UI', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('owner: tax-mapping list shows status badges and creates a new mapping', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:tax-mappings:list', {
      ok: true,
      status: 200,
      data: { mappings: [TAX_MAPPING_ACTIVE], filter: 'active' },
    });
    await stub(app, 'aphub:tax-mappings:discover', {
      ok: true,
      status: 200,
      data: { taxCodes: [{ Id: 'TAX8', Name: 'GST 8%', Active: true }] },
    });
    const created = { ...TAX_MAPPING_ACTIVE, id: 3, provider_tax_code: 'TAX8' };
    await stub(app, 'aphub:tax-mappings:create', { ok: true, status: 201, data: { mapping: created } });

    await win.goto('file:///settings/tax-mapping');
    await expect(win.getByTestId('tax-mapping-page')).toBeVisible();
    await expect(win.getByTestId(`tax-mapping-status-${TAX_MAPPING_ACTIVE.id}`)).toContainText('Active');

    await win.getByTestId('tax-mapping-new-btn').click();
    await win.getByTestId('tax-code-manual-input').fill('TAX8');
    await win.locator('#tm-connection').fill('10');
    await win.locator('#tm-treatment').fill('standard_sales_tax');
    await win.getByTestId('tax-mapping-form-submit-create').click();
    await expect(win.getByTestId('tax-mapping-notice')).toContainText('Created mapping');
  });

  test('non-owner gets a graceful not-authorized state on tax-mapping pages (403)', async () => {
    await stubMe(app, BOOKKEEPER);

    await win.goto('file:///settings/tax-mapping');
    await expect(win.getByTestId('tax-mapping-not-authorized')).toBeVisible();

    await win.goto('file:///exceptions/tax');
    await expect(win.getByTestId('tax-mapping-not-authorized')).toBeVisible();
  });

  test('owner: tax-mapping detail shows the real audit trail (with reason) and can revalidate', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:tax-mappings:get', { ok: true, status: 200, data: { mapping: TAX_MAPPING_STALE } });
    await stub(app, 'aphub:tax-mappings:audit', {
      ok: true,
      status: 200,
      data: {
        audit: [
          {
            id: 1,
            tax_mapping_id: 2,
            connection_id: TAX_MAPPING_STALE.connection_id,
            provider: TAX_MAPPING_STALE.provider,
            changed_by: 1,
            action: 'create',
            reason: 'initial setup',
            changed_at: new Date().toISOString(),
          },
        ],
      },
    });
    const revalidated = { ...TAX_MAPPING_STALE, active: true, needs_revalidation: false };
    await stub(app, 'aphub:tax-mappings:revalidate', { ok: true, status: 200, data: { mapping: revalidated } });

    await win.goto('file:///settings/tax-mapping/2');
    await expect(win.getByTestId('tax-mapping-detail-page')).toBeVisible();
    await expect(win.getByTestId('tax-mapping-audit-trail')).toContainText('initial setup');
    await expect(win.getByTestId('tax-mapping-audit-gap-notice')).toHaveCount(0);
    await win.getByTestId('tax-mapping-revalidate-btn').click();
    await expect(win.getByTestId('tax-mapping-detail-notice')).toContainText('still supported');
  });

  test('owner: tax exceptions queue lists stale/needs_revalidation mappings with a fix link', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:tax-mappings:list', {
      ok: true,
      status: 200,
      data: { mappings: [TAX_MAPPING_ACTIVE, TAX_MAPPING_STALE], filter: 'all' },
    });

    await win.goto('file:///exceptions/tax');
    await expect(win.getByTestId('tax-exceptions-page')).toBeVisible();
    await expect(win.getByTestId(`tax-exception-row-${TAX_MAPPING_STALE.id}`)).toBeVisible();
    await expect(win.getByTestId(`tax-exception-row-${TAX_MAPPING_ACTIVE.id}`)).toHaveCount(0);
    await win.getByTestId(`tax-exception-row-${TAX_MAPPING_STALE.id}`).getByRole('link', { name: 'View / fix' }).click();
  });
});
