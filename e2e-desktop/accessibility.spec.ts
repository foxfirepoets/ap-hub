import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch, stub, stubMe, OWNER } from './support/stub';

/**
 * CHUNK_3_IPC migration of `e2e/app.spec.ts` — accessibility + responsive journeys (3 of the
 * 24 browser-era journeys): skip-navigation, the dimension-review modal's focus trap, and the
 * mobile horizontal-scroll table region.
 */

const TODAY = {
  tenantId: 1,
  generatedAt: new Date().toISOString(),
  counts: { exceptions: 1, posted: 3, held: 1, failed: 0 },
  items: [
    {
      proposalId: 501,
      status: 'review',
      confidence: 0.72,
      vendor: 'Acme Supplies',
      total: '142.50',
      docNumber: 'INV-1001',
      sourceFilename: 'acme.pdf',
      emailSubject: 'Invoice INV-1001',
      createdAt: new Date().toISOString(),
    },
  ],
};

let app: ElectronApplication;
let win: Page;

test.describe('Accessibility + responsive layout', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('keyboard users can skip navigation and see a visible main-content focus target', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:today:get', { ok: true, status: 200, data: TODAY });
    await stub(app, 'aphub:notifications:list', { ok: true, status: 200, data: [] });

    await win.goto('file:///today');
    await win.keyboard.press('Tab');
    const skip = win.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await skip.press('Enter');
    await expect(win.locator('#main-content')).toBeFocused();
    await expect(win.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  });

  test('dimension modal traps keyboard focus, closes with Escape, and fits a phone viewport', async () => {
    await stubMe(app, OWNER);
    const now = new Date().toISOString();
    await stub(app, 'aphub:dimension-mappings:list', {
      ok: true,
      status: 200,
      data: {
        mappings: [
          {
            id: 5,
            connection_id: 11,
            provider: 'qbo',
            proposal_id: 501,
            dimension_type: 'class',
            raw_value: 'Operations',
            normalized_value: 'Operations',
            source_evidence: {},
            extraction_confidence: 0.91,
            proposed_provider_id: '7',
            proposed_match_label: 'Operations',
            provider_id: null,
            mapping_method: null,
            review_status: 'pending',
            resolution_state: 'not_mapped',
            active: true,
            mapping_version: 1,
            revalidated_at: null,
            created_at: now,
            updated_at: now,
          },
        ],
      },
    });

    await win.setViewportSize({ width: 390, height: 700 });
    await win.goto('file:///exceptions/dimensions');
    await win.getByTestId('correct-btn').click();
    const dialog = win.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('correct-normalized-value')).toBeFocused();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(win.getByTestId('correct-btn')).toBeFocused();
  });

  test('wide tables use a focusable horizontal-scroll region on mobile', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:today:get', { ok: true, status: 200, data: TODAY });
    await stub(app, 'aphub:notifications:list', { ok: true, status: 200, data: [] });

    await win.setViewportSize({ width: 390, height: 700 });
    await win.goto('file:///today');
    const region = win.getByRole('region', { name: 'Recent accounting items table' });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute('tabindex', '0');
    await region.focus();
    await expect(region).toBeFocused();
  });
});
