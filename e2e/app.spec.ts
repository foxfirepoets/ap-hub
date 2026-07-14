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
