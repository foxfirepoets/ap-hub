/**
 * Xero AccountingConnector (CHUNK_10, Task 1). Built on the official `xero-node` SDK's
 * `AccountingApi` — never the Xero MCP server (built for LLM tool-calling, not a
 * deterministic backend pipeline). Structural mirror of `src/connectors/qbo.ts`: same
 * delegation pattern, same fail-closed read-back guarantee, translated to Xero's actual
 * API shape (Bills = Invoices with Type=ACCPAY; Contacts, never writing IsSupplier;
 * Tracking Categories capped at 2 active, applied at line level).
 *
 * OAuth / token refresh is explicitly OUT of scope here (CHUNK_10 Task 2). This module
 * accepts an already-authenticated `AccountingApi` (accessToken already set) exactly as
 * `qbo/write.ts` accepts an already-fresh `accessToken` — token lifecycle lives in the
 * auth layer, never here.
 */

import { AccountingApi, Contact, Invoice, LineItem, LineItemTracking } from 'xero-node';
import type {
  CanonicalBill,
  CanonicalRecord,
  CanonicalVendor,
  CanonicalAccount,
  CanonicalEntityKind,
  CanonicalDimension,
  Unsupported,
} from '../canonical/model.js';
import type {
  AccountingConnector,
  AttachOk,
  CapabilityMatrix,
  CompanyIdentity,
  CreateResult,
  IdentityResult,
  PostingTxn,
  PostedRef,
  ReadBackResult,
} from './types.js';
import { mappedSupportedDimensions } from '../mapping/dimensions.js';

/**
 * Xero's structural dimension shape — carried over UNCHANGED from
 * `stubs.ts:72` per this task's instructions. One caveat learned while implementing
 * (not a change to the declared capability, just how the ceiling is enforced): unlike
 * QBO's `dimensions` array, which is an allow-list of fixed KIND NAMES (class, location),
 * Xero's real ceiling is a COUNT — max 2 *active* Tracking Categories per org, whatever
 * their kind names are (Xero orgs configure their own category names). `gapsFor` below
 * therefore caps by count of distinct kinds encountered, not by name allow-list.
 */
const XERO_DIMENSIONS = ['tracking_category'];
const MAX_ACTIVE_TRACKING_CATEGORIES = 2;

export class XeroProductionWriteRefused extends Error {
  constructor() {
    super('Xero production (non-Demo) writes require the explicit production write gate.');
    this.name = 'XeroProductionWriteRefused';
  }
}

// --- Xero API error / 429 retry handling -----------------------------------------
// xero-node's generated client rejects with `JSON.stringify({ response: { statusCode,
// headers, body }, body })` on any non-2xx (see node_modules/xero-node ApiError). We
// parse that shape back out to find the status code and any Retry-After header.

interface ParsedXeroError {
  statusCode?: number;
  retryAfterMs?: number;
  message: string;
}

function parseXeroError(err: unknown): ParsedXeroError {
  let parsed: any = err;
  if (typeof err === 'string') {
    try {
      parsed = JSON.parse(err);
    } catch {
      parsed = { message: err };
    }
  }
  const statusCode: number | undefined = parsed?.response?.statusCode ?? parsed?.statusCode ?? undefined;
  const headers: Record<string, unknown> = parsed?.response?.headers ?? {};
  const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After'];
  let retryAfterMs: number | undefined;
  if (retryAfterRaw != null) {
    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, seconds) * 1000;
  }
  // Never surface raw body (may carry tenant/company detail) beyond a short message.
  const bodyMessage = parsed?.response?.body?.Message ?? parsed?.response?.body?.message;
  const message = bodyMessage ? String(bodyMessage) : (parsed?.message ?? 'Xero API request failed');
  return { statusCode, retryAfterMs, message };
}

export interface XeroRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one Xero API call with 429 + Retry-After backoff. Any other failure (or the
 *  final 429 attempt) throws a normalized Error with `.status` set. */
async function withRetry<T>(fn: () => Promise<T>, opts: Required<XeroRetryOptions>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const { statusCode, retryAfterMs, message } = parseXeroError(err);
      if (statusCode !== 429 || attempt >= opts.maxAttempts) {
        const wrapped = new Error(`Xero API error${statusCode ? ` (${statusCode})` : ''}: ${message}`);
        (wrapped as any).status = statusCode;
        (wrapped as any).cause = err;
        throw wrapped;
      }
      await opts.sleep(retryAfterMs ?? opts.baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
}

// --- Dimension translation (mirrors qbo.ts's gapsFor, adapted to a count ceiling) --

/** The first N distinct dimension kinds encountered (header dims, then line dims, in
 *  order) are the "active" ones Xero can actually carry — everything after that is
 *  surfaced as Unsupported by gapsFor, never silently dropped or overwritten. */
function activeTrackingKinds(dims: CanonicalDimension[]): string[] {
  const kinds: string[] = [];
  for (const d of dims) {
    if (kinds.includes(d.kind)) continue;
    if (kinds.length >= MAX_ACTIVE_TRACKING_CATEGORIES) continue;
    kinds.push(d.kind);
  }
  return kinds;
}

function gapsFor(bill: CanonicalBill, onUnsupported?: (u: Unsupported) => void): Unsupported[] {
  const gaps: Unsupported[] = [];
  const allDims = [...(bill.dimensions ?? []), ...bill.lines.flatMap((l) => l.dimensions ?? [])];
  const active = activeTrackingKinds(allDims);
  const seen = new Set<string>();
  for (const d of allDims) {
    if (seen.has(d.kind)) continue;
    seen.add(d.kind);
    if (!active.includes(d.kind)) {
      const u: Unsupported = {
        unsupported: true,
        field: `dimensions.${d.kind}`,
        reason: `Xero supports max ${MAX_ACTIVE_TRACKING_CATEGORIES} active Tracking Categories per org; "${d.kind}" exceeds that ceiling`,
      };
      gaps.push(u);
      onUnsupported?.(u);
    }
  }
  return gaps;
}

/**
 * Builds LineItem.tracking[] for one line, given the bill-wide allowed kinds (already
 * capped to 2) and a header-level fallback (mirrors qbo.ts's headerClass fallback).
 * Uses Name/Option matching rather than TrackingCategoryID/TrackingOptionID: the
 * canonical dimension carries `id` + `name` but no separate category-ID slot, and
 * Xero's API accepts either form on write. If a future chunk resolves dimension.id to
 * an actual Xero TrackingOptionID, this should switch to the ID form (stricter,
 * preferred by Xero over name matching).
 */
function buildLineTracking(
  lineDims: CanonicalDimension[] | undefined,
  headerDims: CanonicalDimension[],
  allowedKinds: string[],
): LineItemTracking[] {
  const mappedLine = mappedSupportedDimensions(lineDims, allowedKinds);
  const mappedHeader = mappedSupportedDimensions(headerDims, allowedKinds);
  const out: LineItemTracking[] = [];
  for (const kind of allowedKinds) {
    const d = mappedLine.find((x) => x.kind === kind) ?? mappedHeader.find((x) => x.kind === kind);
    if (!d) continue;
    out.push({ name: d.kind, option: d.name ?? d.raw ?? d.id ?? '' });
  }
  return out;
}

// --- PostingTxn (opaque, provider-neutral field names populated by the pipeline;
// see qbo.ts's own header comment) translation for the live posting path -----------

function xeroDedupWhere(txn: any): string | null {
  const contactId = txn?.vendorRef?.value;
  const doc = txn?.DocNumber;
  if (!contactId && !doc) return null;
  const parts: string[] = ['Type=="ACCPAY"'];
  if (doc) parts.push(`InvoiceNumber=="${String(doc).replace(/"/g, '')}"`);
  if (contactId) parts.push(`Contact.ContactID=Guid("${String(contactId).replace(/[^a-zA-Z0-9-]/g, '')}")`);
  return parts.join(' && ');
}

function xeroLineItemsFromTxn(txn: any, allowedKinds: string[]): LineItem[] {
  const headerDims: CanonicalDimension[] = Array.isArray(txn?.dimensions) ? txn.dimensions : [];
  const lines = Array.isArray(txn?.lines) ? txn.lines : [];
  if (!lines.length) {
    return [{
      description: txn?.memo,
      lineAmount: Number(txn?.TotalAmt),
      accountCode: txn?.accountRef?.value,
      tracking: buildLineTracking(undefined, headerDims, allowedKinds),
    }];
  }
  return lines.map((l: any) => ({
    description: l?.description,
    lineAmount: Number(l?.Amount),
    accountCode: l?.accountRef?.value,
    tracking: buildLineTracking(Array.isArray(l?.dimensions) ? l.dimensions : undefined, headerDims, allowedKinds),
  }));
}

function xeroPostingPayload(txn: any): Invoice {
  const headerDims: CanonicalDimension[] = Array.isArray(txn?.dimensions) ? txn.dimensions : [];
  const lineDims: CanonicalDimension[] = Array.isArray(txn?.lines)
    ? txn.lines.flatMap((l: any) => (Array.isArray(l?.dimensions) ? l.dimensions : []))
    : [];
  const allowedKinds = activeTrackingKinds([...headerDims, ...lineDims]);
  const payload: Invoice = {
    type: Invoice.TypeEnum.ACCPAY,
    lineItems: xeroLineItemsFromTxn(txn, allowedKinds),
    date: txn?.TxnDate,
    invoiceNumber: txn?.DocNumber,
    status: Invoice.StatusEnum.AUTHORISED,
  };
  if (txn?.DueDate) payload.dueDate = txn.DueDate;
  if (txn?.vendorRef?.value) payload.contact = { contactID: String(txn.vendorRef.value) };
  return payload;
}

function xeroAmountDocMatches(txn: any, readBack: any): boolean {
  const amtA = Number(txn?.TotalAmt ?? 0);
  const amtB = Number(readBack?.total ?? 0);
  if (Math.abs(amtA - amtB) > 0.01) return false;
  if (txn?.DocNumber && String(txn.DocNumber) !== String(readBack?.invoiceNumber ?? '')) return false;
  return true;
}

function xeroReadBackTrackingOption(kind: string, readBack: any): string | undefined {
  const lines: any[] = Array.isArray(readBack?.lineItems) ? readBack.lineItems : [];
  for (const l of lines) {
    const tracking: any[] = Array.isArray(l?.tracking) ? l.tracking : [];
    const hit = tracking.find((t) => t?.name === kind);
    if (hit) return hit.option == null ? undefined : String(hit.option);
  }
  return undefined;
}

function xeroFirstDimensionMismatch(txn: any, readBack: any): { kind: string; expected: string; found: string | null } | null {
  const headerDims: CanonicalDimension[] = Array.isArray(txn?.dimensions) ? txn.dimensions : [];
  const lineDims: CanonicalDimension[] = Array.isArray(txn?.lines)
    ? txn.lines.flatMap((l: any) => (Array.isArray(l?.dimensions) ? l.dimensions : []))
    : [];
  const allowedKinds = activeTrackingKinds([...headerDims, ...lineDims]);
  const dims = mappedSupportedDimensions([...headerDims, ...lineDims], allowedKinds);
  for (const d of dims) {
    const expected = d.name ?? d.raw ?? d.id;
    if (expected == null) continue;
    const found = xeroReadBackTrackingOption(d.kind, readBack);
    if (found !== String(expected)) return { kind: d.kind, expected: String(expected), found: found ?? null };
  }
  return null;
}

/** `UpdatedDateUTC` is Xero's revision token. A missing/malformed value on read-back
 *  is a fail-closed condition (per this chunk's spec) — never defaulted, never
 *  silently accepted as posted. */
function xeroRevisionOf(raw: any): string {
  const iso = raw?.updatedDateUTCString ?? (raw?.updatedDateUTC instanceof Date ? raw.updatedDateUTC.toISOString() : undefined);
  if (!iso || Number.isNaN(Date.parse(String(iso)))) {
    throw new Error('XERO_READBACK_MISSING_REVISION: read-back is missing a valid UpdatedDateUTC — refusing to treat as posted.');
  }
  return String(iso);
}

// --- Canonical (non-posting) translation for create()/read() ----------------------

function canonicalBillToXeroInvoice(bill: CanonicalBill): Invoice {
  const allDims = [...(bill.dimensions ?? []), ...bill.lines.flatMap((l) => l.dimensions ?? [])];
  const allowedKinds = activeTrackingKinds(allDims);
  const lineItems: LineItem[] = bill.lines.length
    ? bill.lines.map((l) => ({
        description: l.description,
        lineAmount: Number(l.amount),
        accountCode: l.accountId,
        tracking: buildLineTracking(l.dimensions, bill.dimensions ?? [], allowedKinds),
      }))
    : [{
        lineAmount: Number(bill.total),
        description: bill.memo,
        tracking: buildLineTracking(undefined, bill.dimensions ?? [], allowedKinds),
      }];
  const invoice: Invoice = {
    type: Invoice.TypeEnum.ACCPAY,
    lineItems,
    date: bill.txnDate,
    invoiceNumber: bill.docNumber,
    status: Invoice.StatusEnum.AUTHORISED,
  };
  if (bill.dueDate) invoice.dueDate = bill.dueDate;
  if (bill.vendorId) invoice.contact = { contactID: bill.vendorId };
  return invoice;
}

export interface XeroConnectorDeps {
  /** Pre-authenticated xero-node AccountingApi (accessToken already set — OAuth/token
   *  refresh belongs to the auth layer, CHUNK_10 Task 2, never this file). */
  accountingApi: AccountingApi;
  /** The connected Xero organisation identifier — sent as `Xero-tenant-id` per call. */
  tenantId: string;
  /** 'production' requires productionWriteEnabled=true (mirrors QBO_PRODUCTION_WRITE_ENABLED
   *  / qbo/write.ts's own gate). Defaults to 'demo' — the safe default. */
  env?: 'demo' | 'production';
  productionWriteEnabled?: boolean;
  /** Organisation name to match in verifyCompanyIdentity (from config/onboarding). */
  expectedCompanyName?: string;
  /** Audit hook invoked for every Unsupported field (never silently dropped). */
  onUnsupported?: (u: Unsupported) => void;
  retry?: XeroRetryOptions;
}

export function createXeroConnector(deps: XeroConnectorDeps): AccountingConnector {
  if ((deps.env ?? 'demo') === 'production' && deps.productionWriteEnabled !== true) {
    throw new XeroProductionWriteRefused();
  }

  const { accountingApi, tenantId, onUnsupported } = deps;
  const retryOpts: Required<XeroRetryOptions> = {
    maxAttempts: deps.retry?.maxAttempts ?? 4,
    baseDelayMs: deps.retry?.baseDelayMs ?? 500,
    sleep: deps.retry?.sleep ?? defaultSleep,
  };
  const call = <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, retryOpts);

  function capabilities(): CapabilityMatrix {
    return {
      // Carried over unchanged from stubs.ts:65-79 per this task's instructions. NOTE:
      // 'bill' read is declared here (Xero can read Invoices) but this file's read()
      // only implements 'vendor' and 'account' — this task's explicit scope (see
      // CHUNK_10 Task 1 prompt). The posting path uses postBill/readBackVerify, not a
      // generic read('bill'), so this is not a functional gap for anything wired today.
      read: ['vendor', 'account', 'bill'],
      write: ['bill'],
      attachments: true,
      purchaseOrders: true,
      itemReceipts: false,
      dimensions: [...XERO_DIMENSIONS],
      multiCurrency: true,
      multiEntity: false,
      changeFeed: 'webhook',
      idempotency: 'native',
      unsupported: [],
    };
  }

  return {
    provider: 'xero',
    connectionClass: 'cloud',
    companyId: tenantId,
    capabilities,

    async verifyCompanyIdentity(expected: CompanyIdentity): Promise<IdentityResult> {
      const res = await call(() => accountingApi.getOrganisations(tenantId));
      const org = res.body?.organisations?.[0];
      const actual = String(org?.name ?? '').trim();
      return actual && actual === expected.name.trim() ? 'match' : 'mismatch';
    },

    async read(entity: CanonicalEntityKind): Promise<CanonicalRecord[]> {
      if (entity === 'vendor') {
        const res = await call(() => accountingApi.getContacts(tenantId));
        const rows = res.body?.contacts ?? [];
        return rows.map((c: Contact) => {
          const v: CanonicalVendor = { id: String(c.contactID ?? ''), name: String(c.name ?? '') };
          return { kind: 'vendor', canonical: v, providerRaw: c as unknown as Record<string, unknown> };
        });
      }
      if (entity === 'account') {
        const res = await call(() => accountingApi.getAccounts(tenantId));
        const rows = res.body?.accounts ?? [];
        return rows.map((a) => {
          const acc: CanonicalAccount = {
            id: String(a.accountID ?? ''),
            name: String(a.name ?? ''),
            accountType: a.type != null ? String(a.type) : undefined,
          };
          return { kind: 'account', canonical: acc, providerRaw: a as unknown as Record<string, unknown> };
        });
      }
      throw new Error(`Xero connector read('${entity}') is not implemented — this task's scope is 'vendor' and 'account' only.`);
    },

    async create(entity: CanonicalEntityKind, record: CanonicalRecord, idempotencyKey: string): Promise<CreateResult> {
      if (entity === 'vendor') {
        const vendor = record.canonical as unknown as CanonicalVendor;
        // Plain Contact only — IsSupplier is read-only/derived by Xero after a posted
        // ACCPAY document; never set here (writing it would be a bug, per this chunk's
        // spec §"vendor read/create uses Xero Contacts").
        const contactPayload: Contact = { name: vendor.name };
        const res = await call(() => accountingApi.createContacts(tenantId, { contacts: [contactPayload] }, undefined, idempotencyKey));
        const created = res.body?.contacts?.[0];
        if (!created?.contactID) throw new Error('Xero createContacts returned no ContactID.');
        return {
          external: { provider: 'xero', id: String(created.contactID), revision: xeroRevisionOf(created) },
          capabilityGaps: [],
        };
      }
      if (entity === 'bill') {
        const bill = record.canonical as unknown as CanonicalBill;
        const gaps = gapsFor(bill, onUnsupported);
        const invoicePayload = canonicalBillToXeroInvoice(bill);
        const res = await call(() => accountingApi.createInvoices(tenantId, { invoices: [invoicePayload] }, undefined, undefined, idempotencyKey));
        const created = res.body?.invoices?.[0];
        if (!created?.invoiceID) throw new Error('Xero createInvoices returned no InvoiceID.');
        return {
          external: { provider: 'xero', id: String(created.invoiceID), revision: xeroRevisionOf(created) },
          capabilityGaps: gaps,
        };
      }
      throw new Error(`Xero connector create supports 'vendor' and 'bill' only, got '${entity}'`);
    },

    async readBack(entity: CanonicalEntityKind, externalId: string): Promise<CanonicalRecord> {
      if (entity === 'vendor') {
        const res = await call(() => accountingApi.getContact(tenantId, externalId));
        const raw = res.body?.contacts?.[0];
        if (!raw) throw new Error(`Xero readBack('vendor', ${externalId}) found no Contact.`);
        const revision = xeroRevisionOf(raw);
        return { kind: entity, canonical: raw as unknown, providerRaw: raw as unknown as Record<string, unknown>, external: { provider: 'xero', id: externalId, revision } };
      }
      const res = await call(() => accountingApi.getInvoice(tenantId, externalId));
      const raw = res.body?.invoices?.[0];
      if (!raw) throw new Error(`Xero readBack('${entity}', ${externalId}) found no Invoice.`);
      const revision = xeroRevisionOf(raw);
      return { kind: entity, canonical: raw as unknown, providerRaw: raw as unknown as Record<string, unknown>, external: { provider: 'xero', id: externalId, revision } };
    },

    async attach(entity: CanonicalEntityKind, externalId: string, doc: Buffer, filename: string): Promise<AttachOk | Unsupported> {
      if (entity !== 'bill') {
        return { unsupported: true, field: `attach.${entity}`, reason: `Xero connector attach() supports 'bill' (Invoice) only in this task's scope` };
      }
      await call(() => accountingApi.createInvoiceAttachmentByFileName(tenantId, externalId, filename, doc));
      return { attached: true };
    },

    // --- Live posting operations (mirrors qbo.ts's F4 section) ---

    async detectExisting(txn: PostingTxn, _idempotencyKey: string): Promise<PostedRef | null> {
      const where = xeroDedupWhere(txn);
      if (!where) return null;
      // Propagates on error → the pipeline holds fail-closed (dedup_unavailable).
      const res = await call(() => accountingApi.getInvoices(tenantId, undefined, where));
      const rows = res.body?.invoices ?? [];
      const expectedContact = String((txn as any)?.vendorRef?.value ?? '');
      const expectedAmount = Number((txn as any)?.TotalAmt);
      const exact = rows.filter((row) => {
        const contactId = String(row?.contact?.contactID ?? '');
        const amount = Number(row?.total);
        return (!expectedContact || contactId === expectedContact) &&
          Number.isFinite(expectedAmount) && Number.isFinite(amount) &&
          Math.abs(expectedAmount - amount) <= 0.01;
      });
      if (exact.length === 0) return null;
      if (exact.length > 1) throw new Error('XERO_AMBIGUOUS_DUPLICATE_MATCH');
      const raw = exact[0]!;
      return { externalId: String(raw.invoiceID ?? ''), revision: xeroRevisionOf(raw), raw: raw as unknown as Record<string, unknown> };
    },

    async postBill(txn: PostingTxn, idempotencyKey: string): Promise<PostedRef> {
      const payload = xeroPostingPayload(txn);
      const res = await call(() => accountingApi.createInvoices(tenantId, { invoices: [payload] }, undefined, undefined, idempotencyKey));
      const created = res.body?.invoices?.[0];
      if (!created?.invoiceID) throw new Error('Xero createInvoices (postBill) returned no InvoiceID.');
      return { externalId: String(created.invoiceID), revision: xeroRevisionOf(created), raw: created as unknown as Record<string, unknown> };
    },

    async attachDocument(externalId: string, doc: Buffer, filename: string): Promise<void> {
      await call(() => accountingApi.createInvoiceAttachmentByFileName(tenantId, externalId, filename, doc));
    },

    async readBackVerify(txn: PostingTxn, externalId: string): Promise<ReadBackResult> {
      const res = await call(() => accountingApi.getInvoice(tenantId, externalId));
      const raw = res.body?.invoices?.[0];
      if (!raw) throw new Error(`Xero readBackVerify found no Invoice for ${externalId}.`);
      // Throws (fail-closed) on a missing/malformed UpdatedDateUTC — never silently
      // accepted as posted. Same guarantee as detectExisting's throw-on-unknown.
      const revision = xeroRevisionOf(raw);
      const rawRecord = raw as unknown as Record<string, unknown>;
      if (!xeroAmountDocMatches(txn, raw)) {
        const amtOk = Math.abs(Number((txn as any)?.TotalAmt ?? 0) - Number(raw.total ?? 0)) <= 0.01;
        return { verify: 'mismatch', reason: amtOk ? 'docnumber' : 'amount', revision, raw: rawRecord };
      }
      const dimMiss = xeroFirstDimensionMismatch(txn, raw);
      if (dimMiss) return { verify: 'mismatch', reason: 'dimension', detail: dimMiss, revision, raw: rawRecord };
      return { verify: 'match', revision, raw: rawRecord };
    },

    async close(): Promise<void> {
      /* stateless HTTP client; nothing to close */
    },
  };
}

export interface XeroConnectorFromTokenDeps {
  accessToken: string;
  tenantId: string;
  env?: 'demo' | 'production';
  productionWriteEnabled?: boolean;
  basePath?: string;
}

/** Build a Xero connector from a raw access token (production wiring, Task 5). Token
 *  freshness/refresh is the caller's responsibility — this is delegation only,
 *  mirroring qbo.ts's `qboConnectorFromDeps`. */
export function xeroConnectorFromToken(raw: XeroConnectorFromTokenDeps, expectedCompanyName?: string): AccountingConnector {
  const accountingApi = new AccountingApi(raw.basePath);
  accountingApi.accessToken = raw.accessToken;
  return createXeroConnector({
    accountingApi,
    tenantId: raw.tenantId,
    env: raw.env,
    productionWriteEnabled: raw.productionWriteEnabled,
    expectedCompanyName,
  });
}
