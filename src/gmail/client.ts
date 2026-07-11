/**
 * Gmail access is READ-ONLY everywhere except the CHUNK_4 gatekeeper relay, whose
 * `sendForward` can address ONLY the tenant's configured QBO capture address.
 *
 * The pipeline depends on this interface, not googleapis, so logic is testable with
 * a mock and the real adapter stays thin. The real adapter is built lazily to avoid
 * importing the heavy SDK in unit tests.
 */

export interface GmailMessageHeaderInfo {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  receivedAt: string;
  historyId?: string;
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface GmailMessage extends GmailMessageHeaderInfo {
  bodyText: string;
  attachments: GmailAttachment[];
  /** The full RFC822 raw message, used by the gatekeeper to forward verbatim. */
  raw?: Buffer;
}

export interface GmailHistoryResult {
  messages: GmailMessageHeaderInfo[];
  newHistoryId: string;
}

export interface GmailClient {
  /** Incremental fetch of new message ids under the watched label since historyId. */
  listHistory(startHistoryId: string | null): Promise<GmailHistoryResult>;
  getMessage(id: string): Promise<GmailMessage>;
  /**
   * Forward a message to a FIXED recipient. The recipient is bound at construction
   * (the tenant's QBO capture address); this method intentionally takes NO recipient
   * parameter — see gatekeeper send-lockdown (Phase 0.5 §9).
   */
  sendForward(messageId: string): Promise<{ sendId: string; to: string }>;
  /** Search sent mail for a subject tag — used for forward replay-adoption. */
  findSentBySubjectTag(tag: string): Promise<string | null>;
}

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthError';
  }
}
