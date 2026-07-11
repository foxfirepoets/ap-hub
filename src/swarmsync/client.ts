import { logger, redact } from '../logger.js';

/**
 * Thin SwarmSync proof-platform client (Amendment A1). NO SDK dependency — a plain
 * fetch wrapper with retry/backoff, timeout, bearer auth, and redaction.
 *
 * - InvoiceProof:  POST {webBase}/api/scan/invoices        (public, no auth)
 * - Verify-API:    POST {apiBase}/api/verify               (Bearer ssk_ key)
 * - AuditProof:    POST {apiBase}/api/verify (source_type=audit_proof)
 * - chain verify:  GET  {apiBase}/api/proof/:id/export/verify
 *
 * DO NOT reimplement fraud rules or crypto here — this only talks to the platform.
 */

export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export interface SwarmSyncOptions {
  apiBase: string;
  webBase: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  retries?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
}

export interface InvoiceScanInput {
  invoices: Array<Record<string, unknown>>;
  vendorMaster?: Array<Record<string, unknown>>;
  paymentHistory?: Array<Record<string, unknown>>;
  poRegister?: Array<Record<string, unknown>>;
}

export interface InvoiceFinding {
  severity: 'critical' | 'high' | 'medium';
  pattern: string;
  detail?: string;
  rows?: string[];
  evidence?: string;
}

export interface InvoiceScanResult {
  findings: InvoiceFinding[];
  raw: any;
}

export interface VerifyResult {
  proof_id: string | null;
  chain_hash: string | null;
  verification_status: string | null;
  confidence: number | null;
  raw: any;
}

export class SwarmSyncError extends Error {
  constructor(
    message: string,
    readonly product: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SwarmSyncError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SwarmSyncClient {
  private readonly apiBase: string;
  private readonly webBase: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly backoffBaseMs: number;

  constructor(opts: SwarmSyncOptions) {
    this.apiBase = opts.apiBase.replace(/\/$/, '');
    this.webBase = opts.webBase.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.retries = opts.retries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 300;
  }

  private async request(
    method: string,
    url: string,
    body: unknown,
    product: string,
    auth: boolean,
  ): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (auth) headers['authorization'] = `Bearer ${this.apiKey}`;
        const res = await this.withTimeout(
          this.fetchImpl(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
        if (!res.ok) {
          // 4xx (except 429) is not retryable.
          if (res.status < 500 && res.status !== 429) {
            const text = await safeText(res);
            throw new SwarmSyncError(
              `${product} ${method} ${url} → ${res.status}: ${text}`,
              product,
              res.status,
            );
          }
          throw new SwarmSyncError(`${product} ${method} ${url} → ${res.status}`, product, res.status);
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        // Non-retryable client error → bail immediately.
        if (err instanceof SwarmSyncError && err.status && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt < this.retries) {
          const wait = this.backoffBaseMs * Math.pow(2, attempt);
          logger.warn({ product, attempt, wait, err: redact(String(err)) }, 'swarmsync retry');
          await sleep(wait);
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new SwarmSyncError(`${product} request failed`, product);
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SwarmSyncError('request timed out', 'timeout')),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** InvoiceProof fraud scan (public). Normalizes findings[] regardless of envelope. */
  async scanInvoices(input: InvoiceScanInput): Promise<InvoiceScanResult> {
    const raw = await this.request(
      'POST',
      `${this.webBase}/api/scan/invoices`,
      input,
      'invoiceproof',
      false,
    );
    const findings: InvoiceFinding[] = Array.isArray(raw?.findings)
      ? raw.findings
      : Array.isArray(raw?.results)
        ? raw.results.flatMap((r: any) => r?.findings ?? [])
        : [];
    return { findings, raw };
  }

  /** Verify-API document verification (Bearer). */
  async verifyDocument(output: unknown, evidence: unknown): Promise<VerifyResult> {
    const raw = await this.request(
      'POST',
      `${this.apiBase}/api/verify`,
      { source_type: 'document', output, evidence },
      'verify_api',
      true,
    );
    return normalizeVerify(raw);
  }

  /** AuditProof anchor (Bearer, source_type=audit_proof). */
  async auditProof(output: unknown): Promise<VerifyResult> {
    const raw = await this.request(
      'POST',
      `${this.apiBase}/api/verify`,
      { source_type: 'audit_proof', output },
      'auditproof',
      true,
    );
    return normalizeVerify(raw);
  }

  /** Chain-hash verification of a stored proof (integration check). */
  async exportVerify(proofId: string): Promise<any> {
    return this.request(
      'GET',
      `${this.apiBase}/api/proof/${encodeURIComponent(proofId)}/export/verify`,
      undefined,
      'verify_api',
      false,
    );
  }
}

function normalizeVerify(raw: any): VerifyResult {
  return {
    proof_id: raw?.proof_id ?? raw?.proofId ?? raw?.proof?.id ?? null,
    chain_hash: raw?.chain_hash ?? raw?.chainHash ?? raw?.proof?.chain_hash ?? null,
    verification_status: raw?.verification_status ?? raw?.status ?? null,
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    raw,
  };
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
