/**
 * Telegram hold-alert sender (Phase 0.5). One HTTPS Bot API call — NO SDK. Alerts
 * carry vendor/invoice/amount/reason/forward-id only, NEVER bank details or PII.
 * A delivery failure throws so the caller records `alert_failed` and retries; the
 * hold itself never depends on alert success.
 */
export interface TelegramSender {
  send(text: string): Promise<void>;
}

export interface TelegramDeps {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
}

export function createTelegramSender(deps: TelegramDeps): TelegramSender {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  return {
    async send(text: string): Promise<void> {
      const url = `https://api.telegram.org/bot${deps.botToken}/sendMessage`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: deps.chatId, text }),
      });
      if (!res.ok) throw new Error(`telegram sendMessage → ${res.status}`);
      const body = (await res.json()) as { ok?: boolean };
      if (!body.ok) throw new Error('telegram sendMessage returned ok=false');
    },
  };
}

/** Build a hold-alert message that contains no bank details or PII. */
export function holdAlertText(input: {
  vendor?: string;
  invoiceNo?: string;
  amount?: number | string;
  reason: string;
  forwardId: number;
}): string {
  const vendor = input.vendor || 'unknown vendor';
  const inv = input.invoiceNo ? ` #${input.invoiceNo}` : '';
  const amt = input.amount !== undefined && input.amount !== '' ? ` ($${input.amount})` : '';
  return (
    `⛔ HELD: ${vendor}${inv}${amt} — ${input.reason}. ` +
    `Not forwarded to QuickBooks. Verify, then: gatekeeper release ${input.forwardId}.`
  );
}
