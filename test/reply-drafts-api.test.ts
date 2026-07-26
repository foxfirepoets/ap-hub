import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/auth/session.js';
import {
  GmailComposeScopeError,
  GmailDraftResultUnknownError,
  type GmailDraftClient,
} from '../src/gmail/drafts.js';
import { query } from '../src/db/pool.js';
import {
  runCreateReplyDraft,
  runDiscardReplyDraft,
  runReadReplyDraft,
  runUpdateReplyDraft,
} from '../src/reply-drafts/http.js';
import type { ReplyDraftDependencies } from '../src/reply-drafts/service.js';
import {
  closeAll,
  countRows,
  createTenant,
  createUser,
  insertMessage,
  resetTables,
} from './helpers.js';

async function token(tenantId: number, role = 'owner_controller'): Promise<string> {
  const userId = await createUser(tenantId, {
    role,
    email: `${role}-${performance.now()}@example.test`,
  });
  return (await createSession(userId)).token;
}

async function message(tenantId: number): Promise<number> {
  const id = await insertMessage(tenantId, {
    gmailId: `gmail-${tenantId}-${performance.now()}`,
    subject: 'Invoice clarification',
    from: 'Vendor Billing <billing@vendor.test>',
  });
  await query('UPDATE messages SET thread_id=$2 WHERE tenant_id=$1 AND id=$3', [
    tenantId,
    `thread-${tenantId}-${id}`,
    id,
  ]);
  return id;
}

function request(
  method: string,
  bearer: string | null,
  body?: unknown,
  url = 'http://localhost/api/reply-drafts',
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function client(): GmailDraftClient {
  return {
    createInSourceThread: vi.fn().mockImplementation(async (source) => ({
      providerDraftId: 'gmail-draft-1',
      providerMessageId: 'gmail-draft-message-1',
      threadId: source.threadId,
      to: 'billing@vendor.test',
      status: 'created',
    })),
    reconcileCreateInSourceThread: vi.fn().mockResolvedValue(null),
    updateInSourceThread: vi.fn().mockImplementation(async (id, source) => ({
      providerDraftId: id,
      providerMessageId: 'gmail-draft-message-2',
      threadId: source.threadId,
      to: 'billing@vendor.test',
      status: 'created',
    })),
    readStatus: vi.fn().mockImplementation(async (id, threadId) => ({
      providerDraftId: id,
      providerMessageId: 'gmail-draft-message-2',
      threadId,
      to: '',
      status: 'created',
    })),
    discard: vi.fn().mockResolvedValue(undefined),
  };
}

function deps(api = client()): ReplyDraftDependencies & { api: GmailDraftClient } {
  return { api, getClient: vi.fn().mockResolvedValue(api) };
}

async function data(response: Response): Promise<Record<string, any>> {
  return (await response.json() as { data: Record<string, any> }).data;
}

describe('CHUNK_4 reply draft API', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('creates, reads, updates, and discards a source-thread draft with append-only human audit', async () => {
    const tenantId = await createTenant();
    const messageId = await message(tenantId);
    const bearer = await token(tenantId, 'bookkeeper');
    const d = deps();

    const createdResponse = await runCreateReplyDraft(
      request('POST', bearer, {
        messageId,
        subject: 'Re: Invoice clarification',
        bodyText: 'Please confirm the tax amount.',
        reason: 'Missing tax detail',
      }),
      d,
    );
    expect(createdResponse.status).toBe(200);
    const created = await data(createdResponse);
    expect(created).toMatchObject({
      messageId: Number(messageId),
      externalDraftId: 'gmail-draft-1',
      status: 'created',
      sendControl: 'human_in_gmail',
    });
    expect(d.api.createInSourceThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: `thread-${tenantId}-${messageId}` }),
      expect.objectContaining({ bodyText: 'Please confirm the tax amount.' }),
    );

    const read = await runReadReplyDraft(
      request('GET', bearer, undefined, `http://localhost/api/reply-drafts?messageId=${messageId}`),
      d,
    );
    expect(read.status).toBe(200);
    expect((await data(read)).status).toBe('created');

    const updatedResponse = await runUpdateReplyDraft(
      request('PATCH', bearer, {
        subject: 'Re: Invoice clarification',
        bodyText: 'Please confirm tax and payment terms.',
        reason: 'Added terms question',
      }),
      created.id,
      d,
    );
    expect(updatedResponse.status).toBe(200);
    expect(await data(updatedResponse)).toMatchObject({
      status: 'updated',
      bodyText: 'Please confirm tax and payment terms.',
    });

    const discarded = await runDiscardReplyDraft(
      request('DELETE', bearer),
      created.id,
      d,
    );
    expect(discarded.status).toBe(200);
    expect((await data(discarded)).status).toBe('discarded');
    expect(d.api.discard).toHaveBeenCalledWith(
      'gmail-draft-1',
      `thread-${tenantId}-${messageId}`,
    );

    const audits = await query<{ action: string; actor: string; detail: Record<string, unknown> }>(
      `SELECT action,actor,detail FROM audit_log
        WHERE tenant_id=$1 AND action LIKE 'reply_draft.%' ORDER BY id`,
      [tenantId],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'reply_draft.prepared',
      'reply_draft.updated',
      'reply_draft.discarded',
    ]);
    expect(audits.rows.every((row) => row.actor !== 'system')).toBe(true);
    expect(audits.rows.every((row) => row.detail.humanSendsInGmail === true)).toBe(true);
  });

  it('preserves proposed local copy and reconnect guidance when compose scope is missing', async () => {
    const tenantId = await createTenant();
    const messageId = await message(tenantId);
    const bearer = await token(tenantId);
    const missing = deps();
    vi.mocked(missing.api.createInSourceThread).mockRejectedValue(new GmailComposeScopeError());

    const response = await runCreateReplyDraft(
      request('POST', bearer, {
        messageId,
        subject: 'Re: Invoice',
        bodyText: 'Please reconnect and keep this copy.',
      }),
      missing,
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      error: { code: 'GMAIL_COMPOSE_SCOPE_REQUIRED' },
    });
    const stored = await query<{ body_text: string; status: string; gmail_draft_id: string | null }>(
      'SELECT body_text,status,gmail_draft_id FROM reply_drafts WHERE tenant_id=$1',
      [tenantId],
    );
    expect(stored.rows[0]).toEqual({
      body_text: 'Please reconnect and keep this copy.',
      status: 'proposed',
      gmail_draft_id: null,
    });
    expect(await countRows('audit_log', "action='reply_draft.prepared'")).toBe(1);
  });

  it('holds an ambiguous create and adopts it before any later mutation', async () => {
    const tenantId = await createTenant();
    const messageId = await message(tenantId);
    const bearer = await token(tenantId);
    const d = deps();
    vi.mocked(d.api.createInSourceThread)
      .mockRejectedValueOnce(new GmailDraftResultUnknownError('timeout after create'));

    const response = await runCreateReplyDraft(
      request('POST', bearer, {
        messageId,
        subject: 'Re: Invoice',
        bodyText: 'Please clarify.',
      }),
      d,
    );
    expect(response.status).toBe(503);
    const held = (await query<{ id: number; status: string }>(
      'SELECT id,status FROM reply_drafts WHERE tenant_id=$1',
      [tenantId],
    )).rows[0]!;
    expect(held.status).toBe('result_unknown');
    expect(d.api.createInSourceThread).toHaveBeenCalledTimes(1);

    const repeated = await runCreateReplyDraft(
      request('POST', bearer, {
        messageId,
        subject: 'Re: Invoice',
        bodyText: 'Please clarify.',
      }),
      d,
    );
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      error: { code: 'REPLY_DRAFT_EXISTS' },
    });
    expect(d.api.createInSourceThread).toHaveBeenCalledTimes(1);

    vi.mocked(d.api.reconcileCreateInSourceThread).mockResolvedValue({
      providerDraftId: 'adopted-draft',
      providerMessageId: 'adopted-message',
      threadId: `thread-${tenantId}-${messageId}`,
      to: 'billing@vendor.test',
      status: 'created',
    });
    const updated = await runUpdateReplyDraft(
      request('PATCH', bearer, {
        subject: 'Re: Invoice',
        bodyText: 'Please clarify the total.',
      }),
      Number(held.id),
      d,
    );
    expect(updated.status).toBe(200);
    expect(d.api.reconcileCreateInSourceThread).toHaveBeenCalledTimes(1);
    expect(d.api.updateInSourceThread).toHaveBeenCalledWith(
      'adopted-draft',
      expect.any(Object),
      expect.any(Object),
    );
    expect(d.api.createInSourceThread).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown create held when reconciliation finds nothing', async () => {
    const tenantId = await createTenant();
    const messageId = await message(tenantId);
    const bearer = await token(tenantId);
    const d = deps();
    vi.mocked(d.api.createInSourceThread)
      .mockRejectedValueOnce(new GmailDraftResultUnknownError('timeout after create'));
    await runCreateReplyDraft(
      request('POST', bearer, { messageId, subject: 'Re: Invoice', bodyText: 'Question.' }),
      d,
    );
    const held = (await query<{ id: number }>(
      'SELECT id FROM reply_drafts WHERE tenant_id=$1',
      [tenantId],
    )).rows[0]!;

    const update = await runUpdateReplyDraft(
      request('PATCH', bearer, { subject: 'Re: Invoice', bodyText: 'Changed.' }),
      Number(held.id),
      d,
    );
    expect(update.status).toBe(503);
    expect(d.api.createInSourceThread).toHaveBeenCalledTimes(1);
    expect(d.api.updateInSourceThread).not.toHaveBeenCalled();
    expect((await query<{ status: string }>(
      'SELECT status FROM reply_drafts WHERE id=$1',
      [held.id],
    )).rows[0]!.status).toBe('result_unknown');

    const discard = await runDiscardReplyDraft(request('DELETE', bearer), Number(held.id), d);
    expect(discard.status).toBe(503);
    expect(d.api.discard).not.toHaveBeenCalled();
    expect((await query<{ status: string }>(
      'SELECT status FROM reply_drafts WHERE id=$1',
      [held.id],
    )).rows[0]!.status).toBe('result_unknown');
  });

  it('allows only one provider create across simultaneous first-create requests', async () => {
    const tenantId = await createTenant();
    const messageId = await message(tenantId);
    const bearer = await token(tenantId);
    const d = deps();
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    vi.mocked(d.api.createInSourceThread).mockImplementationOnce(async (source) => {
      markProviderStarted();
      await providerGate;
      return {
        providerDraftId: 'gmail-draft-race',
        providerMessageId: 'gmail-message-race',
        threadId: source.threadId,
        to: 'billing@vendor.test',
        status: 'created',
      };
    });
    const body = {
      messageId,
      subject: 'Re: Invoice',
      bodyText: 'One draft only.',
    };
    const first = runCreateReplyDraft(request('POST', bearer, body), d);
    await providerStarted;
    const second = runCreateReplyDraft(request('POST', bearer, body), d);
    releaseProvider();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(d.api.createInSourceThread).toHaveBeenCalledTimes(1);
    expect(await countRows('reply_drafts', 'tenant_id=$1 AND message_id=$2', [
      tenantId,
      messageId,
    ])).toBe(1);
  });

  it('holds an ambiguous update and reads the known provider id before retry', async () => {
    const tenantId = await createTenant();
    const messageId = await message(tenantId);
    const bearer = await token(tenantId);
    const d = deps();
    const created = await data(await runCreateReplyDraft(
      request('POST', bearer, {
        messageId,
        subject: 'Re: Invoice',
        bodyText: 'Original question.',
      }),
      d,
    ));
    vi.mocked(d.api.updateInSourceThread)
      .mockRejectedValueOnce(new GmailDraftResultUnknownError('timeout after update'));

    const ambiguous = await runUpdateReplyDraft(
      request('PATCH', bearer, {
        subject: 'Re: Invoice',
        bodyText: 'Changed question.',
      }),
      created.id,
      d,
    );
    expect(ambiguous.status).toBe(503);
    expect((await query<{ status: string; gmail_draft_id: string }>(
      'SELECT status,gmail_draft_id FROM reply_drafts WHERE id=$1',
      [created.id],
    )).rows[0]).toMatchObject({
      status: 'result_unknown',
      gmail_draft_id: 'gmail-draft-1',
    });

    vi.mocked(d.api.updateInSourceThread).mockClear();
    const retried = await runUpdateReplyDraft(
      request('PATCH', bearer, {
        subject: 'Re: Invoice',
        bodyText: 'Final question.',
      }),
      created.id,
      d,
    );
    expect(retried.status).toBe(200);
    expect(d.api.readStatus).toHaveBeenCalledWith(
      'gmail-draft-1',
      `thread-${tenantId}-${messageId}`,
    );
    expect(d.api.updateInSourceThread).toHaveBeenCalledTimes(1);
    expect(d.api.reconcileCreateInSourceThread).not.toHaveBeenCalled();
  });

  it('projects a human-sent Gmail status and refuses every later application mutation', async () => {
    const tenantId = await createTenant();
    const messageId = await message(tenantId);
    const bearer = await token(tenantId);
    const d = deps();
    const created = await data(await runCreateReplyDraft(
      request('POST', bearer, {
        messageId,
        subject: 'Re: Invoice',
        bodyText: 'Human will send this.',
      }),
      d,
    ));
    vi.mocked(d.api.readStatus).mockResolvedValue({
      providerDraftId: created.externalDraftId,
      providerMessageId: 'sent-message-1',
      threadId: created.threadId,
      to: '',
      status: 'sent_external',
    });

    const projected = await runReadReplyDraft(
      request('GET', bearer, undefined, `http://localhost/api/reply-drafts?messageId=${messageId}`),
      d,
    );
    expect((await data(projected)).status).toBe('sent_external');
    expect((await query<{ status: string }>('SELECT status FROM reply_drafts WHERE id=$1', [created.id]))
      .rows[0]!.status).toBe('sent_external');

    expect((await runUpdateReplyDraft(
      request('PATCH', bearer, { subject: 'x', bodyText: 'try again' }),
      created.id,
      d,
    )).status).toBe(409);
    expect((await runDiscardReplyDraft(request('DELETE', bearer), created.id, d)).status).toBe(409);
    expect(d.api.updateInSourceThread).not.toHaveBeenCalled();
    expect(d.api.discard).not.toHaveBeenCalled();
    expect(await countRows('audit_log', "action IN ('reply_draft.updated','reply_draft.discarded')")).toBe(0);
  });

  it('allows CPA reads only, rejects unauthenticated access, and hides foreign resources', async () => {
    const tenantA = await createTenant('A');
    const tenantB = await createTenant('B');
    const messageA = await message(tenantA);
    const ownerA = await token(tenantA);
    const cpaA = await token(tenantA, 'cpa');
    const ownerB = await token(tenantB);
    const d = deps();
    const created = await data(await runCreateReplyDraft(
      request('POST', ownerA, { messageId: messageA, subject: 'Re: A', bodyText: 'Question' }),
      d,
    ));

    expect((await runReadReplyDraft(
      request('GET', cpaA, undefined, `http://localhost/api/reply-drafts?messageId=${messageA}`),
      d,
    )).status).toBe(200);
    expect((await runUpdateReplyDraft(
      request('PATCH', cpaA, { subject: 'Re: A', bodyText: 'CPA mutation' }),
      created.id,
      d,
    )).status).toBe(403);
    expect((await runDiscardReplyDraft(request('DELETE', cpaA), created.id, d)).status).toBe(403);
    expect((await runReadReplyDraft(
      request('GET', ownerB, undefined, `http://localhost/api/reply-drafts?messageId=${messageA}`),
      d,
    )).status).toBe(404);
    expect((await runUpdateReplyDraft(
      request('PATCH', ownerB, { subject: 'Re: A', bodyText: 'Foreign mutation' }),
      created.id,
      d,
    )).status).toBe(404);
    expect((await runReadReplyDraft(
      request('GET', null, undefined, `http://localhost/api/reply-drafts?messageId=${messageA}`),
      d,
    )).status).toBe(401);
    expect(await countRows('audit_log', "action='reply_draft.updated'")).toBe(0);
  });

  it('has no application send operation in runtime exports, routes, or draft service architecture', async () => {
    const runtime = await import('../src/reply-drafts/index.js');
    expect(Object.keys(runtime).some((key) => /send/i.test(key))).toBe(false);

    const paths = [
      '../src/reply-drafts/service.ts',
      '../src/reply-drafts/http.ts',
      // CHUNK_3_IPC replaced the two `app/api/reply-drafts/**` route handlers with these; the
      // scan follows the surface rather than shrinking when the old files were deleted.
      '../desktop/ipc/read/reply-drafts.ts',
      '../desktop/ipc/action/replyDrafts.ts',
    ];
    const source = paths.map((path) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')).join('\n');
    expect(source).not.toMatch(/users\.messages\.send|sendReply|sendForward|runSend/i);
    expect(source).not.toMatch(/\b(?:send|transmit)(?:Email|Reply|Message)?\s*\(/i);
    const serviceImports = readFileSync(
      fileURLToPath(new URL('../src/reply-drafts/service.ts', import.meta.url)),
      'utf8',
    ).split(/\r?\n/).filter((line) => /^\s*(?:import|} from)\b/.test(line)).join('\n');
    expect(serviceImports).not.toMatch(/gmail\/(?:adapter|client)|gatekeeper\/forwarder/);
  });
});
