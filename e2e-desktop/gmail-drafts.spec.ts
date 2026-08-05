import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, stub, stubMe, stubThrow, OWNER, BOOKKEEPER, CPA } from './support/stub';

/**
 * CHUNK_3_IPC migration of `e2e/app.spec.ts` — the Gmail reply-draft lifecycle (7 of the 24
 * browser-era journeys). One of these (the "no transmission control" test) additionally moves
 * from source-inspecting `app/api/reply-drafts/**` (deleted this chunk) to
 * `desktop/ipc/read/reply-drafts.ts` and `desktop/ipc/action/replyDrafts.ts`, keeping the same
 * assertion: this surface must never expose a send/transmission control or code path.
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

let app: ElectronApplication;
let win: Page;

async function stubExceptionsQueue(): Promise<void> {
  await stub(app, 'aphub:exceptions:list', { ok: true, status: 200, data: EXCEPTIONS });
  await stub(app, 'aphub:evidence:get', { ok: true, status: 200, data: EVIDENCE_501 });
  await stub(app, 'aphub:accounting-documents:review', { ok: true, status: 200, data: [] });
}

test.describe('Gmail reply-draft lifecycle', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app, win } = await launch());
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('owner prepares, edits, opens, and discards a source-thread Gmail draft', async () => {
    await stubMe(app, OWNER);
    await stubExceptionsQueue();

    await app.evaluate(({ ipcMain }, seed) => {
      let draft: (typeof seed & Record<string, unknown>) | null = null;
      for (const channel of [
        'aphub:reply-drafts:get',
        'aphub:reply-drafts:create',
        'aphub:reply-drafts:update',
        'aphub:reply-drafts:discard',
      ]) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle('aphub:reply-drafts:get', () =>
        draft
          ? { ok: true, status: 200, data: draft }
          : { ok: false, status: 404, code: 'NOT_FOUND', message: 'reply draft not found' },
      );
      ipcMain.handle('aphub:reply-drafts:create', (_event, payload: Record<string, unknown>) => {
        draft = { ...seed, ...payload };
        return { ok: true, status: 200, data: draft };
      });
      ipcMain.handle('aphub:reply-drafts:update', (_event, payload: Record<string, unknown>) => {
        draft = { ...(draft ?? seed), ...payload, status: 'updated' };
        return { ok: true, status: 200, data: draft };
      });
      ipcMain.handle('aphub:reply-drafts:discard', () => {
        draft = { ...(draft ?? seed), status: 'discarded' };
        return { ok: true, status: 200, data: draft };
      });
    }, REPLY_DRAFT);

    await win.goto('file:///exceptions');
    await win.getByLabel('Message').fill('Please confirm the purchase order number.');
    await win.getByLabel('Internal reason (optional)').fill('Missing purchase order');
    await win.getByTestId('draft-save').click();
    await expect(win.getByTestId('reply-draft-notice')).toContainText('prepared in Gmail');

    const gmail = win.getByTestId('draft-open-gmail');
    await expect(gmail).toHaveAttribute('href', 'https://mail.google.com/mail/#all/thread-source-abc');
    await win.getByLabel('Message').fill('Please confirm the PO number and due date.');
    await win.getByTestId('draft-save').click();
    await expect(win.getByTestId('reply-draft-notice')).toContainText('changes saved');

    win.on('dialog', (dialog) => void dialog.accept());
    await win.getByTestId('draft-discard').click();
    await expect(win.getByTestId('draft-discarded')).toBeVisible();
    await expect(win.getByTestId('draft-save')).toHaveCount(0);
  });

  test('missing Gmail compose scope preserves copy and gives the owner a recovery path', async () => {
    await stubMe(app, OWNER);
    await stubExceptionsQueue();

    await app.evaluate(({ ipcMain }, seed) => {
      let proposed: Record<string, unknown> | null = null;
      ipcMain.removeHandler('aphub:reply-drafts:get');
      ipcMain.removeHandler('aphub:reply-drafts:create');
      ipcMain.handle('aphub:reply-drafts:get', () =>
        proposed
          ? { ok: true, status: 200, data: proposed }
          : { ok: false, status: 404, code: 'NOT_FOUND', message: 'reply draft not found' },
      );
      ipcMain.handle('aphub:reply-drafts:create', (_event, payload: Record<string, unknown>) => {
        proposed = { ...seed, ...payload, externalDraftId: null, status: 'proposed' };
        return { ok: false, status: 428, code: 'GMAIL_COMPOSE_SCOPE_REQUIRED', message: 'compose scope required' };
      });
    }, REPLY_DRAFT);

    await win.goto('file:///exceptions');
    await win.getByLabel('Message').fill('Please share the missing purchase order.');
    await win.getByTestId('draft-save').click();
    await expect(win.getByTestId('reply-draft-notice')).toContainText('copy is saved here');
    await expect(win.getByTestId('gmail-compose-reconnect')).toHaveAttribute('href', '/api/connections/gmail/start');
    await expect(win.getByLabel('Message')).toHaveValue('Please share the missing purchase order.');
  });

  test('bookkeeper can prepare drafts while CPA remains read-only', async () => {
    await stubExceptionsQueue();
    await stub(app, 'aphub:reply-drafts:get', { ok: true, status: 200, data: REPLY_DRAFT });

    await stubMe(app, BOOKKEEPER);
    await win.goto('file:///exceptions');
    await expect(win.getByTestId('draft-save')).toBeVisible();
    await expect(win.getByTestId('draft-discard')).toBeVisible();

    await stubMe(app, CPA);
    await win.goto('file:///exceptions');
    await expect(win.getByTestId('draft-readonly')).toBeVisible();
    await expect(win.getByLabel('Message')).toHaveAttribute('readonly', '');
    await expect(win.getByTestId('draft-save')).toHaveCount(0);
    await expect(win.getByTestId('draft-discard')).toHaveCount(0);
    await expect(win.getByTestId('draft-open-gmail')).toBeVisible();
  });

  test('externally sent Gmail projection is immutable even for an owner', async () => {
    await stubMe(app, OWNER);
    await stubExceptionsQueue();
    await stub(app, 'aphub:reply-drafts:get', {
      ok: true,
      status: 200,
      data: { ...REPLY_DRAFT, status: 'sent_external' },
    });

    await win.goto('file:///exceptions');
    await expect(win.getByTestId('draft-sent-external')).toContainText('read-only');
    await expect(win.getByLabel('Message')).toHaveAttribute('readonly', '');
    await expect(win.getByTestId('draft-save')).toHaveCount(0);
    await expect(win.getByTestId('draft-discard')).toHaveCount(0);
    await expect(win.getByTestId('draft-open-gmail')).toBeVisible();
  });

  test('reply draft surface contains no transmission control or provider-send source path', async () => {
    await stubMe(app, OWNER);
    await stubExceptionsQueue();
    await stub(app, 'aphub:reply-drafts:get', { ok: true, status: 200, data: REPLY_DRAFT });

    await win.goto('file:///exceptions');
    const actions = win.getByTestId('reply-draft-actions');
    await expect(actions.getByRole('button', { name: /send/i })).toHaveCount(0);
    await expect(actions.getByRole('link', { name: /send/i })).toHaveCount(0);

    // CHUNK_3_IPC: `app/api/reply-drafts/**` no longer exists — the real surface is these two
    // IPC files. Intent unchanged: prove no send/transmission control or code path exists here.
    const sourceFiles = [
      'app/(app)/exceptions/_components/ReplyDraftPanel.tsx',
      'desktop/ipc/read/reply-drafts.ts',
      'desktop/ipc/action/replyDrafts.ts',
    ];
    const source = (await Promise.all(sourceFiles.map((file) => readFile(join(process.cwd(), file), 'utf8')))).join(
      '\n',
    );
    expect(source).not.toMatch(/users\.messages\.send|messages\/send|sendMessage|sendReply/i);
  });

  test('draft mutation network failure remains unsent, recovers controls, and supports status refresh', async () => {
    await stubMe(app, OWNER);
    await stubExceptionsQueue();
    await stub(app, 'aphub:reply-drafts:get', { ok: true, status: 200, data: REPLY_DRAFT });
    await stubThrow(app, 'aphub:reply-drafts:update');

    await win.goto('file:///exceptions');
    await expect(win.getByTestId('reply-draft-panel')).toContainText('BookScout OS cannot send');
    await expect(win.getByTestId('draft-timestamps')).toContainText('last synced');
    await win.getByLabel('Message').fill('Updated but still unsent.');
    await win.getByTestId('draft-save').click();
    await expect(win.getByTestId('reply-draft-notice')).toContainText('try again', { ignoreCase: true });
    await expect(win.getByTestId('draft-save')).toBeEnabled();

    // The GET recovers so "refresh from Gmail" can succeed, mirroring the browser-era fixture
    // (which never aborted GET, only PATCH).
    await stub(app, 'aphub:reply-drafts:get', { ok: true, status: 200, data: REPLY_DRAFT });
    await win.getByTestId('draft-refresh').click();
    await expect(win.getByTestId('reply-draft-notice')).toContainText('refreshed from Gmail');
  });

  test('Gmail links do not force account zero and show the observed recipient', async () => {
    await stubMe(app, OWNER);
    await stubExceptionsQueue();
    await stub(app, 'aphub:reply-drafts:get', { ok: true, status: 200, data: REPLY_DRAFT });

    await win.goto('file:///exceptions');
    await expect(win.getByLabel('Recipient from source conversation')).toHaveValue('billing@acme.example');
    const link = win.getByTestId('draft-open-gmail');
    await expect(link).toHaveAttribute('href', 'https://mail.google.com/mail/#all/thread-source-abc');
    await expect(link).toHaveText('Open conversation in Gmail');
  });
});
