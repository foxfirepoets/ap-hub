import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createGmailDraftClient,
  deriveReplyRecipient,
  GmailComposeScopeError,
  GmailDraftRetryError,
  type GmailDraftTransport,
  type SourceConversation,
} from '../src/gmail/drafts.js';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, gmailOAuthScopes } from '../src/auth/gmail-oauth.js';
import { GmailAuthError } from '../src/gmail/client.js';

const source: SourceConversation = {
  messageId: 'message-1',
  threadId: 'thread-1',
  from: 'Vendor <billing@vendor.test>',
  replyTo: 'Accounts <accounts@vendor.test>',
  subject: 'Invoice 1001',
};

function transport(): GmailDraftTransport {
  return {
    create: vi.fn().mockResolvedValue({ id: 'draft-1', message: { id: 'draft-message-1', threadId: 'thread-1' } }),
    update: vi.fn().mockResolvedValue({ id: 'draft-1', message: { id: 'draft-message-2', threadId: 'thread-1' } }),
    get: vi.fn().mockResolvedValue({ id: 'draft-1', message: { id: 'draft-message-2', threadId: 'thread-1' } }),
    discard: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Gmail compose scope', () => {
  it('adds only compose to readonly when drafting is enabled', () => {
    expect(gmailOAuthScopes(true)).toEqual([GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE]);
    expect(gmailOAuthScopes(false)).toEqual([GMAIL_READONLY_SCOPE]);
    expect(gmailOAuthScopes(true).join(' ')).not.toMatch(/gmail\.modify|mail\.google\.com/);
  });

  it('preserves proposed copy by failing before provider access when scope is missing', async () => {
    const api = transport();
    const client = createGmailDraftClient(api, GMAIL_READONLY_SCOPE);
    await expect(client.createInSourceThread(source, { subject: source.subject, bodyText: 'Question' }))
      .rejects.toBeInstanceOf(GmailComposeScopeError);
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe('Gmail source-thread draft adapter', () => {
  it('derives Reply-To, creates in the source thread, and returns provider ids', async () => {
    const api = transport();
    const client = createGmailDraftClient(api, `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`);
    const result = await client.createInSourceThread(source, { subject: source.subject, bodyText: 'Please clarify.' });

    expect(result).toEqual({
      providerDraftId: 'draft-1',
      providerMessageId: 'draft-message-1',
      threadId: 'thread-1',
      to: 'accounts@vendor.test',
      status: 'created',
    });
    expect(api.create).toHaveBeenCalledWith(expect.any(String), 'thread-1');
    const raw = Buffer.from(vi.mocked(api.create).mock.calls[0]![0], 'base64url').toString();
    expect(raw).toContain('To: accounts@vendor.test\r\n');
    expect(raw).toContain('Subject: Re: Invoice 1001\r\n');
  });

  it('updates, reads status, and discards only in the bound source thread', async () => {
    const api = transport();
    const client = createGmailDraftClient(api, GMAIL_COMPOSE_SCOPE);
    await expect(client.updateInSourceThread('draft-1', source, { subject: source.subject, bodyText: 'Updated' }))
      .resolves.toMatchObject({ providerDraftId: 'draft-1', threadId: 'thread-1' });
    await expect(client.readStatus('draft-1', 'thread-1')).resolves.toMatchObject({
      providerDraftId: 'draft-1',
      threadId: 'thread-1',
    });
    await expect(client.discard('draft-1', 'thread-1')).resolves.toBeUndefined();
    expect(api.discard).toHaveBeenCalledWith('draft-1');

    await expect(client.discard('draft-1', 'another-thread')).rejects.toThrow('not in the source thread');
    expect(api.discard).toHaveBeenCalledTimes(1);
  });

  it('rejects header injection and unsafe source recipients', () => {
    expect(() => deriveReplyRecipient({ ...source, replyTo: 'bad@example.test\r\nBcc: victim@example.test' }))
      .toThrow('no safe reply recipient');
  });

  it('surfaces token rejection without retry and retries transient failure at most three times', async () => {
    const unauthorized = transport();
    vi.mocked(unauthorized.create).mockRejectedValue({ code: 401 });
    const unauthorizedClient = createGmailDraftClient(unauthorized, GMAIL_COMPOSE_SCOPE);
    await expect(unauthorizedClient.createInSourceThread(source, { subject: 'x', bodyText: 'x' }))
      .rejects.toBeInstanceOf(GmailAuthError);
    expect(unauthorized.create).toHaveBeenCalledTimes(1);

    const unavailable = transport();
    vi.mocked(unavailable.create).mockRejectedValue({ response: { status: 503 } });
    const unavailableClient = createGmailDraftClient(unavailable, GMAIL_COMPOSE_SCOPE);
    await expect(unavailableClient.createInSourceThread(source, { subject: 'x', bodyText: 'x' }))
      .rejects.toBeInstanceOf(GmailDraftRetryError);
    expect(unavailable.create).toHaveBeenCalledTimes(3);
  });

  it('exposes no reply transmission operation', () => {
    const client = createGmailDraftClient(transport(), GMAIL_COMPOSE_SCOPE);
    expect(Object.keys(client).sort()).toEqual([
      'createInSourceThread',
      'discard',
      'readStatus',
      'updateInSourceThread',
    ]);
    const sourceText = readFileSync(new URL('../src/gmail/drafts.ts', import.meta.url), 'utf8');
    expect(sourceText).not.toMatch(/users\.messages\.send\s*\(/);
    expect(sourceText).not.toMatch(/^\s*(?:async\s+)?send\s*\(/m);
  });
});
