import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch, stub, stubMe, BOOKKEEPER, CPA } from './support/stub';

/**
 * CHUNK_3_IPC migration of `e2e/app.spec.ts` — role-gated action visibility on the Exceptions
 * queue (2 of the 24 browser-era journeys).
 */

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

let app: ElectronApplication;
let win: Page;

test.describe('Exceptions role gating', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('bookkeeper sees "Send to Owner", never an Approve→post button', async () => {
    await stubMe(app, BOOKKEEPER);
    await stub(app, 'aphub:exceptions:list', { ok: true, status: 200, data: EXCEPTIONS });
    await stub(app, 'aphub:evidence:get', { ok: true, status: 200, data: EVIDENCE_501 });
    await stub(app, 'aphub:accounting-documents:review', { ok: true, status: 200, data: [] });

    await win.goto('file:///exceptions');
    await win.getByTestId('exception-row-9001').click();
    await expect(win.getByTestId('send-to-owner-btn')).toBeVisible();
    await expect(win.getByTestId('approve-btn')).toHaveCount(0);
    await expect(win.getByTestId('reject-btn')).toBeVisible();
  });

  test('cpa is read-only: no approve, reject, or edit', async () => {
    await stubMe(app, CPA);
    await stub(app, 'aphub:exceptions:list', { ok: true, status: 200, data: EXCEPTIONS });
    await stub(app, 'aphub:evidence:get', { ok: true, status: 200, data: EVIDENCE_501 });
    await stub(app, 'aphub:accounting-documents:review', { ok: true, status: 200, data: [] });

    await win.goto('file:///exceptions');
    await win.getByTestId('exception-row-9001').click();
    await expect(win.getByTestId('action-bar')).toBeVisible();
    await expect(win.getByTestId('approve-btn')).toHaveCount(0);
    await expect(win.getByTestId('send-to-owner-btn')).toHaveCount(0);
    await expect(win.getByTestId('reject-btn')).toHaveCount(0);
    await expect(win.getByTestId('edit-btn')).toHaveCount(0);
  });
});
