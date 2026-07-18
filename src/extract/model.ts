import {
  RawExtractionSchema,
  REQUIRED_FIELDS_FOR_INVOICE,
  type RawExtraction,
  type ExtractionResult,
} from './schema.js';

/**
 * Extraction model layer (CHUNK_5). The pipeline depends on the Extractor interface,
 * not the Anthropic SDK, so extraction logic is testable with a mock. Foot-check and
 * confidence are pure functions.
 */

export interface ExtractInput {
  bytes?: Buffer;
  mime?: string;
  bodyText?: string;
  docTypeHint?: string;
  directionHint?: string;
}

export interface Extractor {
  /** Returns the raw JSON object the model produced (unvalidated). */
  extract(input: ExtractInput): Promise<unknown>;
}

export function validateRaw(json: unknown): RawExtraction {
  return RawExtractionSchema.parse(json);
}

const TOLERANCE = 0.01;

/** Foot-check: total must equal Σ line_items + tax (within a cent). */
export function footCheck(raw: RawExtraction): boolean {
  if (raw.total === null) return true; // nothing to check
  if (raw.line_items.length === 0) return true; // some receipts have no lines
  const sum = raw.line_items.reduce((acc, li) => acc + (li.amount ?? 0), 0) + (raw.tax ?? 0);
  return Math.abs(sum - raw.total) <= TOLERANCE;
}

export function deriveMissingFields(raw: RawExtraction): string[] {
  const missing: string[] = [];
  if (raw.doc_type === 'invoice') {
    for (const f of REQUIRED_FIELDS_FOR_INVOICE) {
      const v = (raw as Record<string, unknown>)[f];
      if (v === null || v === undefined || v === '') missing.push(f);
    }
  } else if (!raw.vendor_name) {
    missing.push('vendor_name');
  }
  return missing;
}

/** Overall confidence = min(component confidences) − missing-required penalty. */
export function computeConfidence(raw: RawExtraction, missing: string[]): number {
  const comps = Object.values(raw.field_confidence ?? {});
  const base = comps.length > 0 ? Math.min(...comps) : 0.5;
  const penalty = missing.length * 0.15;
  return Math.max(0, Math.min(1, base - penalty));
}

export function normalizeExtraction(raw: RawExtraction): ExtractionResult {
  const missing = deriveMissingFields(raw);
  const flags: string[] = [];
  if (!footCheck(raw)) flags.push('total_mismatch');
  const confidence = computeConfidence(raw, missing);
  return { ...raw, confidence, missing_fields: missing, flags };
}

const EXTRACTION_MODEL = 'claude-sonnet-4-5';

/**
 * Build the Anthropic Messages request for an extraction input. Shared by BOTH
 * the direct extractor (SDK) and the broker extractor (HTTP to the broker), so the
 * prompt + vision-content logic lives in exactly ONE place. The broker is a thin
 * passthrough that forwards this exact request with the key injected.
 */
export function buildAnthropicRequest(input: ExtractInput): {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: any[] }>;
} {
  const content: any[] = [
    {
      type: 'text',
      text:
        'Extract the invoice/receipt into strict JSON matching this shape: ' +
        '{vendor_name,invoice_number,invoice_date,due_date,total,tax,line_items:[{description,qty,unit_price,amount,account_hint}],' +
        'payment_terms,remit_to,bank_info,job_ref,class_hint,location_hint,account_hint,doc_type,direction,field_confidence:{field:0..1}}. ' +
        'Use null for unknown fields. Respond with ONLY the JSON.',
    },
  ];
  if (input.bytes && input.mime?.includes('pdf')) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: input.bytes.toString('base64') },
    });
  } else if (input.bytes && input.mime?.startsWith('image/')) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: input.mime, data: input.bytes.toString('base64') },
    });
  } else if (input.bodyText) {
    content.push({ type: 'text', text: `Document text:\n${input.bodyText}` });
  }
  return { model: EXTRACTION_MODEL, max_tokens: 2048, messages: [{ role: 'user', content }] };
}

/** Parse an Anthropic Messages response object into the raw extraction JSON. */
export function parseAnthropicMessageJson(res: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = res.content?.find((b) => b.type === 'text');
  const raw = text?.text ?? '{}';
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
}

/** Real Anthropic vision extractor (lazy — heavy SDK, only used at runtime). */
export async function getAnthropicExtractor(apiKey: string): Promise<Extractor> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });
  return {
    async extract(input: ExtractInput): Promise<unknown> {
      const req = buildAnthropicRequest(input);
      const res = await client.messages.create(req as any);
      return parseAnthropicMessageJson(res as any);
    },
  };
}

/**
 * Broker-mode extractor (CHUNK_4). Builds the SAME Anthropic request as the direct
 * path, then POSTs it to the broker's /v1/extract with the install token. The
 * broker injects Ben's key and relays the raw model response — so no Anthropic key
 * ever lives on the pilot machine. Any non-2xx from the broker (incl. its own 502
 * on an Anthropic failure) throws → the extract pipeline records an exception and
 * does NOT advance the proposal (fail-closed).
 */
export function getBrokerExtractor(
  brokerBaseUrl: string,
  installToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Extractor {
  const base = brokerBaseUrl.replace(/\/$/, '');
  return {
    async extract(input: ExtractInput): Promise<unknown> {
      const req = buildAnthropicRequest(input);
      const res = await fetchImpl(`${base}/v1/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${installToken}` },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        throw new Error(`broker /v1/extract → ${res.status}`);
      }
      const body = await res.json();
      return parseAnthropicMessageJson(body as any);
    },
  };
}

/**
 * Select the extractor from config: broker mode when BROKER_BASE_URL is set
 * (keys live on the broker), otherwise the direct SDK extractor (dev box + tests).
 */
export async function getExtractor(cfg: {
  BROKER_BASE_URL?: string;
  BROKER_INSTALL_TOKEN?: string;
  ANTHROPIC_API_KEY: string;
}): Promise<Extractor> {
  if (cfg.BROKER_BASE_URL) {
    return getBrokerExtractor(cfg.BROKER_BASE_URL, cfg.BROKER_INSTALL_TOKEN ?? '');
  }
  return getAnthropicExtractor(cfg.ANTHROPIC_API_KEY);
}
