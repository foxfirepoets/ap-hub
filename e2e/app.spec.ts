import { test, expect, type Page } from '@playwright/test';

// --- Fixtures (mirror the API's { data } / { error } envelope) -------------------------------

const OWNER = { email: 'owner@example.com', role: 'owner_controller', tenantId: 1 };
const BOOKKEEPER = { email: 'book@example.com', role: 'bookkeeper', tenantId: 1 };
const CPA = { email: 'cpa@example.com', role: 'cpa', tenantId: 1 };

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

const EXCEPTIONS = [
  {
    id: 9001,
    entityRef: 'proposal:501',
    reasonCode: 'low_confidence',
    detail: 'Confidence below auto-post threshold.',
    status: 'open',
    resolvedBy: null,
    resolution: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  },
];

const EVIDENCE_501 = {
  proposalId: 501,
  status: 'review',
  confidence: 0.72,
  email: {
    messageId: 1,
    gmailMessageId: 'gm-abc123',
    subject: 'Invoice INV-1001',
    from: 'billing@acme.example',
    receivedAt: new Date().toISOString(),
  },
  attachment: { attachmentId: 1, filename: 'acme.pdf', sha256: 'a'.repeat(64), mime: 'application/pdf' },
  extraction: {
    extractionId: 1,
    fields: { vendor_name: 'Acme Supplies', total: '142.50', invoice_number: 'INV-1001' },
    confidence: 0.72,
    missingFields: [],
    flags: [],
  },
  priorRule: null,
  proofs: [{ product: 'Verify-API', entityKind: 'extraction', verdict: 'pass', proofId: 'pf-1', chainHash: 'h1' }],
  posting: null,
  qboLink: null,
  missing: [],
};

const APPROVE_POSTED = {
  posting_id: 7001,
  qbo_type: 'Bill',
  qbo_id: '55',
  qbo_link: 'https://app.sandbox.qbo.intuit.com/app/bill?txnId=55&realm=999',
  mode: 'sandbox',
};

// --- Stub helpers ---------------------------------------------------------------------------

async function stubMe(page: Page, me: object | null) {
  await page.route('**/api/me', async (route) => {
    if (me === null) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'no session' } }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: me }) });
    }
  });
}

async function stubReads(page: Page) {
  await page.route('**/api/today', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: TODAY }) }));
  await page.route('**/api/exceptions**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: EXCEPTIONS }) }));
  await page.route('**/api/items/501/evidence', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: EVIDENCE_501 }) }));
  // Mock Google login: the "Sign in with Google" link redirects here; land on Today.
  await page.route('**/api/auth/login**', (r) => r.fulfill({ status: 302, headers: { location: '/today' } }));
}

// --- Tests ----------------------------------------------------------------------------------

test('unauthenticated user is redirected to /login', async ({ page }) => {
  await stubMe(page, null);
  await page.goto('/today');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('google-signin')).toBeVisible();
});

test('owner: login → Today → open exception → view evidence → approve → Posted + QBO link', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  await page.route('**/api/proposals/501/approve', (r) =>
    r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: APPROVE_POSTED }) }),
  );

  // Mock Google login.
  await page.goto('/login');
  await page.getByTestId('google-signin').click();

  // Today.
  await expect(page.getByTestId('today-page')).toBeVisible();
  await expect(page.getByTestId('count-posted')).toContainText('3');

  // Go to the exceptions queue and open the item.
  await page.getByRole('link', { name: 'Exceptions', exact: true }).click();
  await expect(page.getByTestId('exceptions-page')).toBeVisible();
  await page.getByTestId('exception-row-9001').click();

  // Evidence for the linked proposal (501) renders.
  const evidence = page.getByTestId('evidence-panel');
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText('Acme Supplies');

  // Approve → post to QBO sandbox → Posted notice with a QBO link.
  await page.getByTestId('approve-btn').click();
  const notice = page.getByTestId('action-notice');
  await expect(notice).toContainText('Posted to QuickBooks sandbox');
  await expect(page.getByTestId('posted-qbo-link')).toHaveAttribute('href', APPROVE_POSTED.qbo_link);
});

test('bookkeeper sees "Send to Owner", never an Approve→post button', async ({ page }) => {
  await stubMe(page, BOOKKEEPER);
  await stubReads(page);
  await page.goto('/exceptions');
  await page.getByTestId('exception-row-9001').click();
  await expect(page.getByTestId('send-to-owner-btn')).toBeVisible();
  await expect(page.getByTestId('approve-btn')).toHaveCount(0);
  await expect(page.getByTestId('reject-btn')).toBeVisible();
});

test('cpa is read-only: no approve, reject, or edit', async ({ page }) => {
  await stubMe(page, CPA);
  await stubReads(page);
  await page.goto('/exceptions');
  await page.getByTestId('exception-row-9001').click();
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await expect(page.getByTestId('approve-btn')).toHaveCount(0);
  await expect(page.getByTestId('send-to-owner-btn')).toHaveCount(0);
  await expect(page.getByTestId('reject-btn')).toHaveCount(0);
  await expect(page.getByTestId('edit-btn')).toHaveCount(0);
});

// --- F_TAX_MAPPING UI (settings/tax-mapping, settings/tax-mapping/[id], exceptions/tax) ------

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

test('owner: tax-mapping list shows status badges and creates a new mapping', async ({ page }) => {
  await stubMe(page, OWNER);
  await page.route('**/api/tax-mappings?filter=active', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { mappings: [TAX_MAPPING_ACTIVE], filter: 'active' } }) }),
  );
  await page.route('**/api/tax-mappings/discover', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { taxCodes: [{ Id: 'TAX8', Name: 'GST 8%', Active: true }] } }) }),
  );
  const created = { ...TAX_MAPPING_ACTIVE, id: 3, provider_tax_code: 'TAX8' };
  await page.route('**/api/tax-mappings', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { mapping: created } }) });
    }
    return route.fallback();
  });

  await page.goto('/settings/tax-mapping');
  await expect(page.getByTestId('tax-mapping-page')).toBeVisible();
  await expect(page.getByTestId(`tax-mapping-status-${TAX_MAPPING_ACTIVE.id}`)).toContainText('Active');

  await page.getByTestId('tax-mapping-new-btn').click();
  await page.getByTestId('tax-code-manual-input').fill('TAX8');
  await page.locator('#tm-connection').fill('10');
  await page.locator('#tm-treatment').fill('standard_sales_tax');
  await page.getByTestId('tax-mapping-form-submit-create').click();
  await expect(page.getByTestId('tax-mapping-notice')).toContainText('Created mapping');
});

test('non-owner gets a graceful not-authorized state on tax-mapping pages (403)', async ({ page }) => {
  await stubMe(page, BOOKKEEPER);
  await page.goto('/settings/tax-mapping');
  await expect(page.getByTestId('tax-mapping-not-authorized')).toBeVisible();

  await page.goto('/exceptions/tax');
  await expect(page.getByTestId('tax-mapping-not-authorized')).toBeVisible();
});

test('owner: tax-mapping detail shows the real audit trail (with reason) and can revalidate', async ({ page }) => {
  await stubMe(page, OWNER);
  await page.route('**/api/tax-mappings/2', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { mapping: TAX_MAPPING_STALE } }) }),
  );
  await page.route('**/api/tax-mappings/2/audit', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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
      }),
    }),
  );
  const revalidated = { ...TAX_MAPPING_STALE, active: true, needs_revalidation: false };
  await page.route('**/api/tax-mappings/2/revalidate', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { mapping: revalidated } }) }),
  );

  await page.goto('/settings/tax-mapping/2');
  await expect(page.getByTestId('tax-mapping-detail-page')).toBeVisible();
  await expect(page.getByTestId('tax-mapping-audit-trail')).toContainText('initial setup');
  await expect(page.getByTestId('tax-mapping-audit-gap-notice')).toHaveCount(0);
  await page.getByTestId('tax-mapping-revalidate-btn').click();
  await expect(page.getByTestId('tax-mapping-detail-notice')).toContainText('still supported');
});

test('owner: tax exceptions queue lists stale/needs_revalidation mappings with a fix link', async ({ page }) => {
  await stubMe(page, OWNER);
  await page.route('**/api/tax-mappings?filter=all', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { mappings: [TAX_MAPPING_ACTIVE, TAX_MAPPING_STALE], filter: 'all' } }),
    }),
  );

  await page.goto('/exceptions/tax');
  await expect(page.getByTestId('tax-exceptions-page')).toBeVisible();
  await expect(page.getByTestId(`tax-exception-row-${TAX_MAPPING_STALE.id}`)).toBeVisible();
  await expect(page.getByTestId(`tax-exception-row-${TAX_MAPPING_ACTIVE.id}`)).toHaveCount(0);
  await page.getByTestId(`tax-exception-row-${TAX_MAPPING_STALE.id}`).getByRole('link', { name: 'View / fix' }).click();
});
