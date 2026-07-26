import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch, stub, stubMe, trackHttpRequests, OWNER } from './support/stub';

/**
 * CHUNK_3_IPC migration of `e2e/app.spec.ts` — the session gate and the core Today → Exceptions
 * → evidence → approve journey (2 of the 24 browser-era journeys; see support/stub.ts for why
 * the fixture mechanism changed from `page.route` to real `ipcMain` channel overrides).
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

let app: ElectronApplication;
let win: Page;

test.describe('Today + session gate', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('unauthenticated user is redirected to /login', async () => {
    await stubMe(app, null);
    await win.goto('file:///today');
    await expect.poll(() => win.url()).toMatch(/\/login$/);
    await expect(win.getByTestId('retry-signin')).toBeVisible();
  });

  test('owner: Today → open exception → view evidence → approve → Posted + QBO link', async () => {
    await stubMe(app, OWNER);
    await stub(app, 'aphub:today:get', { ok: true, status: 200, data: TODAY });
    await stub(app, 'aphub:notifications:list', { ok: true, status: 200, data: [] });
    await stub(app, 'aphub:exceptions:list', { ok: true, status: 200, data: EXCEPTIONS });
    await stub(app, 'aphub:evidence:get', { ok: true, status: 200, data: EVIDENCE_501 });
    await stub(app, 'aphub:accounting-documents:review', { ok: true, status: 200, data: [] });
    await stub(app, 'aphub:proposals:approve', { ok: true, status: 201, data: APPROVE_POSTED });

    // Required proof (mirrors shell.spec.ts:94): the renderer talks to AP-Hub only through
    // window.aphub.invoke while this whole journey runs — never HTTP, never loopback.
    const requests = trackHttpRequests(win);

    await win.goto('file:///today');
    await expect(win.getByTestId('today-page')).toBeVisible();
    await expect(win.getByTestId('count-posted')).toContainText('3');

    await win.goto('file:///exceptions');
    await expect(win.getByTestId('exceptions-page')).toBeVisible();
    await win.getByTestId('exception-row-9001').click();

    const evidence = win.getByTestId('evidence-panel');
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText('Acme Supplies');

    await win.getByTestId('approve-btn').click();
    const notice = win.getByTestId('action-notice');
    await expect(notice).toContainText('Posted to QuickBooks sandbox');
    await expect(win.getByTestId('posted-qbo-link')).toHaveAttribute('href', APPROVE_POSTED.qbo_link);

    expect(requests).toEqual([]);
  });
});
