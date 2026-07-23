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

/** The instruction shared by every provider — strict JSON, null for unknowns. */
const EXTRACT_INSTRUCTION =
  'Extract the invoice/receipt into strict JSON matching this shape: ' +
  '{vendor_name,invoice_number,invoice_date,due_date,total,tax,line_items:[{description,qty,unit_price,amount,account_hint}],' +
  'payment_terms,remit_to,bank_info,job_ref,class_hint,location_hint,account_hint,doc_type,direction,field_confidence:{field:0..1}}. ' +
  'Use null for unknown fields. Respond with ONLY the JSON.';

function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model returned no JSON object');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * OpenAI-compatible vision extractor (OpenAI, OpenRouter, Groq, Ollama, LM
 * Studio, vLLM, ... — anything speaking /chat/completions). Images are sent as
 * data-URL image_url parts; PDFs are rendered to page images first (full PDF
 * support on providers without native PDF).
 */
export async function getOpenAiCompatibleExtractor(deps: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<Extractor> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const base = deps.baseUrl.replace(/\/$/, '');
  return {
    async extract(input: ExtractInput): Promise<unknown> {
      const content: any[] = [{ type: 'text', text: EXTRACT_INSTRUCTION }];
      const pushImage = (mime: string, b64: string) =>
        content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });

      if (input.bytes && input.mime?.includes('pdf')) {
        const { renderPdfToPngs } = await import('./pdf.js');
        const pages = await renderPdfToPngs(input.bytes);
        for (const png of pages) pushImage('image/png', png.toString('base64'));
      } else if (input.bytes && input.mime?.startsWith('image/')) {
        pushImage(input.mime, input.bytes.toString('base64'));
      } else if (input.bodyText) {
        content.push({ type: 'text', text: `Document text:\n${input.bodyText}` });
      }

      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: deps.model,
          max_tokens: 2048,
          temperature: 0,
          messages: [{ role: 'user', content }],
        }),
      });
      if (!res.ok) throw new Error(`LLM ${base} → ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as any;
      const text = data?.choices?.[0]?.message?.content ?? '{}';
      return firstJsonObject(typeof text === 'string' ? text : JSON.stringify(text));
    },
  };
}

/**
 * Text-only CLI extractor (Claude Code / Codex / Gemini headless). A CLI cannot
 * see images, so scanned invoices are refused with a clear message; only
 * text-bearing documents (email body) are handled. Offered as an explicit
 * fallback, never auto-selected for vision documents.
 */
export async function getCliExtractor(bin: string): Promise<Extractor> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  return {
    async extract(input: ExtractInput): Promise<unknown> {
      const text = input.bodyText;
      if (!text) {
        throw new Error(`${bin} CLI is text-only and cannot read a scanned image/PDF. Use a vision provider (local vision model, OpenAI, or Anthropic) for scanned documents.`);
      }
      const prompt = `${EXTRACT_INSTRUCTION}\n\nDocument text:\n${text}`;
      const { stdout } = await run(bin, ['--print', prompt], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' });
      return firstJsonObject(stdout);
    },
  };
}

/**
 * Provider-agnostic factory: resolve the configured/detected backend and return
 * the matching Extractor. This is what the pipeline uses — ap-hub now runs with
 * a local model, any OpenAI-compatible API, or a cloud key, not only Anthropic.
 */
export async function getExtractor(cfg: import('../config.js').Config): Promise<Extractor> {
  const { resolveProvider } = await import('../llm/provider.js');
  const p = await resolveProvider(cfg);
  if (p.kind === 'anthropic') return getAnthropicExtractor(p.apiKey!, p.model);
  if (p.kind === 'openai') return getOpenAiCompatibleExtractor({ baseUrl: p.baseUrl!, apiKey: p.apiKey, model: p.model });
  return getCliExtractor(p.cliBin!);
}

/** Real Anthropic vision extractor (lazy — heavy SDK, only used at runtime). */
export async function getAnthropicExtractor(apiKey: string, model = 'claude-sonnet-4-5'): Promise<Extractor> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });
  return {
    async extract(input: ExtractInput): Promise<unknown> {
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
      const res = await client.messages.create({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content }],
      });
      const text = res.content.find((b: any) => b.type === 'text');
      const raw = (text as any)?.text ?? '{}';
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    },
  };
}
