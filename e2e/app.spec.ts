import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

const REPLY_DRAFT = {
  id: 41,
  messageId: 1,
  externalDraftId: 'draft-provider-41',
  threadId: 'thread-source-abc',
  toAddress: 'billing@acme.example',
  subject: 'Re: Invoice INV-1001',
  bodyText: 'Could you please confirm the purchase order number?',
  status: 'created',
  reason: 'Missing purchase order',
  createdBy: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sendControl: 'human_in_gmail',
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

test('owner prepares, edits, opens, and discards a source-thread Gmail draft', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  let draft: typeof REPLY_DRAFT | null = null;
  await page.route('**/api/reply-drafts**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill(draft
        ? { status: 200, contentType: 'application/json', body: JSON.stringify({ data: draft }) }
        : { status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'reply draft not found' } }) });
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { subject: string; bodyText: string; reason: string | null };
      draft = { ...REPLY_DRAFT, ...body };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: draft }) });
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { subject: string; bodyText: string; reason: string | null };
      draft = { ...(draft ?? REPLY_DRAFT), ...body, status: 'updated' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: draft }) });
    }
    draft = { ...(draft ?? REPLY_DRAFT), status: 'discarded' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: draft }) });
  });

  await page.goto('/exceptions');
  await page.getByTestId('exception-row-9001').click();
  await page.getByLabel('Message').fill('Please confirm the purchase order number.');
  await page.getByLabel('Internal reason (optional)').fill('Missing purchase order');
  await page.getByTestId('draft-save').click();
  await expect(page.getByTestId('reply-draft-notice')).toContainText('prepared in Gmail');

  const gmail = page.getByTestId('draft-open-gmail');
  await expect(gmail).toHaveAttribute('href', 'https://mail.google.com/mail/#all/thread-source-abc');
  await page.getByLabel('Message').fill('Please confirm the PO number and due date.');
  await page.getByTestId('draft-save').click();
  await expect(page.getByTestId('reply-draft-notice')).toContainText('changes saved');

  page.on('dialog', (dialog) => dialog.accept());
  await page.getByTestId('draft-discard').click();
  await expect(page.getByTestId('draft-discarded')).toBeVisible();
  await expect(page.getByTestId('draft-save')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/evidence/reply-draft-lifecycle.png', fullPage: true });
});

test('missing Gmail compose scope preserves copy and gives the owner a recovery path', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  let proposed: typeof REPLY_DRAFT | null = null;
  await page.route('**/api/reply-drafts**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill(proposed
        ? { status: 200, contentType: 'application/json', body: JSON.stringify({ data: proposed }) }
        : { status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'reply draft not found' } }) });
    }
    const body = request.postDataJSON() as { subject: string; bodyText: string; reason: string | null };
    proposed = { ...REPLY_DRAFT, ...body, externalDraftId: null, status: 'proposed' };
    return route.fulfill({
      status: 428,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'GMAIL_COMPOSE_SCOPE_REQUIRED', message: 'compose scope required' } }),
    });
  });

  await page.goto('/exceptions');
  await page.getByLabel('Message').fill('Please share the missing purchase order.');
  await page.getByTestId('draft-save').click();
  await expect(page.getByTestId('reply-draft-notice')).toContainText('copy is saved here');
  await expect(page.getByTestId('gmail-compose-reconnect')).toHaveAttribute('href', '/api/connections/gmail/start');
  await expect(page.getByLabel('Message')).toHaveValue('Please share the missing purchase order.');
});

test('bookkeeper can prepare drafts while CPA remains read-only', async ({ page }) => {
  await stubMe(page, BOOKKEEPER);
  await stubReads(page);
  await page.route('**/api/reply-drafts**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: REPLY_DRAFT }) }),
  );
  await page.goto('/exceptions');
  await expect(page.getByTestId('draft-save')).toBeVisible();
  await expect(page.getByTestId('draft-discard')).toBeVisible();

  await stubMe(page, CPA);
  await page.goto('/exceptions');
  await expect(page.getByTestId('draft-readonly')).toBeVisible();
  await expect(page.getByLabel('Message')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('draft-save')).toHaveCount(0);
  await expect(page.getByTestId('draft-discard')).toHaveCount(0);
  await expect(page.getByTestId('draft-open-gmail')).toBeVisible();
});

test('externally sent Gmail projection is immutable even for an owner', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  await page.route('**/api/reply-drafts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { ...REPLY_DRAFT, status: 'sent_external' } }),
    }),
  );
  await page.goto('/exceptions');
  await expect(page.getByTestId('draft-sent-external')).toContainText('read-only');
  await expect(page.getByLabel('Message')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('draft-save')).toHaveCount(0);
  await expect(page.getByTestId('draft-discard')).toHaveCount(0);
  await expect(page.getByTestId('draft-open-gmail')).toBeVisible();
});

test('reply draft surface contains no transmission control or provider-send source path', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  await page.route('**/api/reply-drafts**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: REPLY_DRAFT }) }),
  );
  await page.goto('/exceptions');
  const actions = page.getByTestId('reply-draft-actions');
  await expect(actions.getByRole('button', { name: /send/i })).toHaveCount(0);
  await expect(actions.getByRole('link', { name: /send/i })).toHaveCount(0);

  const sourceFiles = [
    'app/(app)/exceptions/_components/ReplyDraftPanel.tsx',
    'app/api/reply-drafts/route.ts',
    'app/api/reply-drafts/[id]/route.ts',
  ];
  const source = (await Promise.all(sourceFiles.map((file) => readFile(join(process.cwd(), file), 'utf8')))).join('\n');
  expect(source).not.toMatch(/users\.messages\.send|messages\/send|sendMessage|sendReply/i);
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

// --- Multi-edition provider health + bank statement review ---------------------------------

const PROVIDER_CONNECTIONS = {
  connections: [
    {
      id: 10,
      provider: 'qbo',
      connectionClass: 'cloud',
      displayName: 'Main operating company',
      externalCompany: 'realm-10',
      status: 'active',
      lastVerifiedAt: new Date().toISOString(),
      edition: 'plus',
      supported: true,
      gaps: [],
      capabilities: ['verify_company', 'query', 'post_bill', 'read_back', 'attach'].map((operation) => ({
        provider: 'qbo', edition: 'plus', operation, supported: true, reason: null, unsupportedFields: [],
      })),
    },
    {
      id: 11,
      provider: 'qbd',
      connectionClass: 'local_desktop',
      displayName: 'Desktop books',
      externalCompany: 'desktop-11',
      status: 'inactive',
      lastVerifiedAt: null,
      edition: 'premier',
      supported: false,
      gaps: ['Connection is inactive; reconnect or reactivate it before using accounting operations.'],
      capabilities: ['verify_company', 'query', 'post_bill', 'read_back', 'attach'].map((operation) => ({
        provider: 'qbd', edition: 'premier', operation, supported: false,
        reason: 'Connection is inactive; reconnect or reactivate it before using accounting operations.',
        unsupportedFields: [],
      })),
    },
    {
      id: 12,
      provider: 'qbo',
      connectionClass: 'cloud',
      displayName: 'Unsupported product',
      externalCompany: 'realm-12',
      status: 'active',
      lastVerifiedAt: null,
      edition: 'self_employed',
      supported: false,
      gaps: ['QuickBooks Online Self-Employed is not supported; connect an Accounting API company.'],
      capabilities: ['verify_company', 'query', 'post_bill', 'read_back', 'attach'].map((operation) => ({
        provider: 'qbo', edition: 'self_employed', operation, supported: false,
        reason: 'QuickBooks Online Self-Employed is not supported; connect an Accounting API company.',
        unsupportedFields: [],
      })),
    },
  ],
};

const STATEMENT_LIST = [{
  id: 71,
  institutionName: 'Community Bank',
  accountHint: '…7788',
  periodStart: '2026-06-01',
  periodEnd: '2026-06-30',
  status: 'review',
  filedAt: null,
  lineCount: 2,
  unresolvedCount: 2,
}];

const STATEMENT_DETAIL = {
  ...STATEMENT_LIST[0],
  documentId: 301,
  currency: 'USD',
  openingBalance: '1000.00',
  closingBalance: '930.00',
  validationDetail: { equation: '1000.00 + -70.00 = 930.00', valid: true },
  lines: [
    { id: 801, lineNo: 1, postedOn: '2026-06-02', description: 'Office rent', amount: '-50.00', balance: '950.00', matchStatus: 'unmatched', matchedProviderRef: null, reviewReason: null },
    { id: 802, lineNo: 2, postedOn: '2026-06-03', description: 'Bank fee', amount: '-20.00', balance: '930.00', matchStatus: 'unmatched', matchedProviderRef: null, reviewReason: null },
  ],
};

async function stubStatementReads(page: Page, detail = STATEMENT_DETAIL) {
  await page.route('**/api/statements', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: STATEMENT_LIST }) }),
  );
  await page.route('**/api/statements/71', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: detail }) }),
  );
}

test('settings presents QBO capability truth and actionable offline QBD health', async ({ page }) => {
  await stubMe(page, OWNER);
  await page.route('**/api/provider-capabilities', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: PROVIDER_CONNECTIONS }) }),
  );
  await page.route('**/api/provider-jobs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { jobs: [{ id: 1, connectionId: 11, operation: 'post_bill', status: 'held', attempts: 1, errorCode: 'UNCERTAIN_OUTCOME', errorDetail: 'provider result unknown', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] } }) }),
  );
  await page.route('**/api/onboarding', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { automationLevel: 'assisted' } }) }),
  );

  await page.goto('/settings');
  await expect(page.getByTestId('provider-10')).toContainText('Healthy');
  await expect(page.getByTestId('provider-10')).toContainText('post bill: Supported');
  await expect(page.getByTestId('provider-11')).toContainText('Offline');
  await expect(page.getByTestId('provider-11')).toContainText('reconnect or reactivate');
  await expect(page.getByTestId('provider-11')).toContainText('1 held');
  await expect(page.getByTestId('provider-12')).toContainText('Unsupported');
  await expect(page.getByTestId('provider-12')).toContainText('Self-Employed is not supported');
  await page.screenshot({ path: 'test-results/evidence/provider-health.png', fullPage: true });
});

test('owner reviews, matches, excludes, and files statement evidence', async ({ page }) => {
  await stubMe(page, OWNER);
  const current = structuredClone(STATEMENT_DETAIL);
  await page.route('**/api/statements', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: STATEMENT_LIST }) }),
  );
  await page.route('**/api/statements/71', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: current }) }),
  );
  await page.route('**/api/statements/71/lines/801/match', (route) => {
    current.lines[0]!.matchStatus = 'matched';
    current.unresolvedCount = 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ok: true } }) });
  });
  await page.route('**/api/statements/71/lines/802/exclude', (route) => {
    current.lines[1]!.matchStatus = 'excluded';
    current.unresolvedCount = 0;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ok: true } }) });
  });
  await page.route('**/api/statements/71/file', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { ok: true } }) }),
  );

  await page.goto('/statements');
  await expect(page.getByTestId('statement-row-71')).toContainText('2 unresolved');
  await page.getByTestId('statement-row-71').getByRole('link', { name: 'Review' }).click();
  await expect(page.getByTestId('statement-detail-page')).toContainText('Source evidence');
  await page.getByLabel('Reason for line 1').fill('Matched to rent bill');
  await page.getByLabel('Provider reference for line 1').fill('bill-500');
  await page.getByTestId('statement-line-801').getByRole('button', { name: 'Match' }).click();
  await expect(page.getByTestId('statement-notice')).toContainText('saved');
  await page.getByLabel('Reason for line 2').fill('Reviewed bank service charge');
  await page.getByTestId('statement-line-802').getByRole('button', { name: 'Exclude' }).click();
  await expect(page.getByTestId('statement-file')).toBeEnabled();
  await page.getByTestId('statement-file').click();
  await expect(page.getByTestId('statement-notice')).toContainText('saved');
  await page.screenshot({ path: 'test-results/evidence/statement-review.png', fullPage: true });
});

test('bookkeeper may review statements; CPA sees evidence read-only', async ({ page }) => {
  await stubMe(page, BOOKKEEPER);
  await stubStatementReads(page);
  await page.goto('/statements/71');
  await expect(page.getByTestId('statement-line-801').getByRole('button', { name: 'Match' })).toBeVisible();
  await expect(page.getByTestId('statement-file')).toBeVisible();

  await stubMe(page, CPA);
  await page.goto('/statements/71');
  await expect(page.getByTestId('statement-readonly')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Match' })).toHaveCount(0);
  await expect(page.getByTestId('statement-file')).toHaveCount(0);
});

test('held statement exposes validation evidence and correction recovery but cannot be filed', async ({ page }) => {
  await stubMe(page, OWNER);
  const held = {
    ...STATEMENT_DETAIL,
    status: 'unbalanced',
    validationDetail: { equation: '1000.00 + -70.00 != 950.00', difference: '20.00' },
  };
  await stubStatementReads(page, held);
  await page.goto('/statements/71');
  await expect(page.getByTestId('statement-held')).toContainText('difference');
  await expect(page.getByRole('button', { name: 'Save correction' })).toBeVisible();
  await expect(page.getByTestId('statement-file')).toBeDisabled();
});

test('statement navigation fails closed for anonymous and foreign-tenant records', async ({ page }) => {
  await stubMe(page, null);
  await page.goto('/statements/71');
  await expect(page).toHaveURL(/\/login$/);

  await stubMe(page, OWNER);
  await page.route('**/api/statements/999', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null }) }),
  );
  await page.goto('/statements/999');
  await expect(page.getByTestId('statement-not-found')).toContainText('not found or unavailable in this company');
  await expect(page.getByTestId('statement-not-found')).not.toContainText('tenant');
});

test('statement mutation network failure recovers controls and gives a retryable message', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubStatementReads(page);
  await page.route('**/api/statements/71/lines/801/match', (route) => route.abort('connectionfailed'));
  await page.goto('/statements/71');
  await page.getByLabel('Reason for line 1').fill('Matched after review');
  await page.getByLabel('Provider reference for line 1').fill('bill-500');
  const match = page.getByTestId('statement-line-801').getByRole('button', { name: 'Match' });
  await match.click();
  await expect(page.getByTestId('statement-notice')).toContainText('try again', { ignoreCase: true });
  await expect(match).toBeEnabled();
});

test('draft mutation network failure remains unsent, recovers controls, and supports status refresh', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  await page.route('**/api/reply-drafts**', async (route) => {
    if (route.request().method() === 'PATCH') return route.abort('connectionfailed');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: REPLY_DRAFT }) });
  });
  await page.goto('/exceptions');
  await expect(page.getByTestId('reply-draft-panel')).toContainText('AP Hub cannot send');
  await expect(page.getByTestId('draft-timestamps')).toContainText('last synced');
  await page.getByLabel('Message').fill('Updated but still unsent.');
  await page.getByTestId('draft-save').click();
  await expect(page.getByTestId('reply-draft-notice')).toContainText('try again', { ignoreCase: true });
  await expect(page.getByTestId('draft-save')).toBeEnabled();
  await page.getByTestId('draft-refresh').click();
  await expect(page.getByTestId('reply-draft-notice')).toContainText('refreshed from Gmail');
});

test('keyboard users can skip navigation and see a visible main-content focus target', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  await page.goto('/today');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await skip.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('Gmail links do not force account zero and show the observed recipient', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  await page.route('**/api/reply-drafts**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: REPLY_DRAFT }) }),
  );
  await page.goto('/exceptions');
  await expect(page.getByLabel('Recipient from source conversation')).toHaveValue('billing@acme.example');
  const link = page.getByTestId('draft-open-gmail');
  await expect(link).toHaveAttribute('href', 'https://mail.google.com/mail/#all/thread-source-abc');
  await expect(link).toHaveText('Open conversation in Gmail');
});

test('dimension modal traps keyboard focus, closes with Escape, and fits a phone viewport', async ({ page }) => {
  await stubMe(page, OWNER);
  const now = new Date().toISOString();
  await page.route('**/api/dimension-mappings**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { mappings: [{
        id: 5, connection_id: 11, provider: 'qbo', proposal_id: 501,
        dimension_type: 'class', raw_value: 'Operations', normalized_value: 'Operations',
        source_evidence: {}, extraction_confidence: 0.91, proposed_provider_id: '7',
        proposed_match_label: 'Operations', provider_id: null, mapping_method: null,
        review_status: 'pending', resolution_state: 'not_mapped', active: true,
        mapping_version: 1, revalidated_at: null, created_at: now, updated_at: now,
      }] } }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto('/exceptions/dimensions');
  await page.getByTestId('correct-btn').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('correct-normalized-value')).toBeFocused();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('correct-btn')).toBeFocused();
});

test('wide tables use a focusable horizontal-scroll region on mobile', async ({ page }) => {
  await stubMe(page, OWNER);
  await stubReads(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto('/today');
  const region = page.getByRole('region', { name: 'Recent accounting items table' });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  await region.focus();
  await expect(region).toBeFocused();
});
