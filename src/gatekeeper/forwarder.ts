import type { GmailClient } from '../gmail/client.js';

/**
 * Send-lockdown (Phase 0.5, HARD REQUIREMENT). The forwarder is bound to ONE
 * recipient at construction and exposes `forward(messageId)` with NO recipient
 * parameter. Before returning it asserts the underlying send addressed exactly the
 * configured address; anything else throws. A bug cannot email anyone else.
 */
export class ForwardRecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForwardRecipientError';
  }
}

export interface LockedForwarder {
  readonly recipient: string;
  forward(messageId: string): Promise<{ sendId: string; to: string }>;
}

export function createLockedForwarder(
  configuredAddress: string,
  gmail: GmailClient,
): LockedForwarder {
  if (!configuredAddress || !configuredAddress.includes('@')) {
    throw new ForwardRecipientError(
      `Refusing to build forwarder: invalid QBO_FORWARDING_ADDRESS "${configuredAddress}"`,
    );
  }
  return {
    recipient: configuredAddress,
    async forward(messageId: string) {
      const result = await gmail.sendForward(messageId);
      // Runtime re-check: the send MUST have gone to the configured address.
      if (result.to !== configuredAddress) {
        throw new ForwardRecipientError(
          `send-lockdown violation: forwarded to "${result.to}", expected "${configuredAddress}"`,
        );
      }
      return result;
    },
  };
}
