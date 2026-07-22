/**
 * qbXML request builders + response parser for the QuickBooks Desktop path.
 *
 * SAFETY: this is the ONLY place qbXML request strings are constructed. Read
 * (…QueryRq) and write (…Add/Mod/Del/VoidRq) requests are both here, but the
 * read-only guard (`assertReadOnlyAllowed`) — enforced by the session/CLI, not
 * this pure module — decides whether a write request may ever be enqueued.
 *
 * Pure + dependency-free so every builder and the parser are unit-tested without
 * QuickBooks present. The live round-trip happens only when the Web Connector
 * polls the SOAP endpoint against an open company file.
 */

export const QBXML_VERSION = '16.0';

export type OnError = 'stopOnError' | 'continueOnError';

/** Escape the five XML entities for text/attribute content. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wrap inner request XML in the qbXML envelope the Web Connector expects. */
export function wrapQbxml(inner: string, onError: OnError = 'stopOnError'): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<?qbxml version="${QBXML_VERSION}"?>\n` +
    `<QBXML>\n<QBXMLMsgsRq onError="${onError}">\n${inner}\n</QBXMLMsgsRq>\n</QBXML>`
  );
}

// --- Read-only queries (safe in every mode) --------------------------------

export function companyQueryRq(requestID = '1'): string {
  return wrapQbxml(`<CompanyQueryRq requestID="${xmlEscape(requestID)}"/>`);
}

export function vendorQueryRq(requestID = '1', maxReturned = 100): string {
  return wrapQbxml(
    `<VendorQueryRq requestID="${xmlEscape(requestID)}"><MaxReturned>${maxReturned}</MaxReturned></VendorQueryRq>`,
  );
}

export function accountQueryRq(requestID = '1'): string {
  return wrapQbxml(`<AccountQueryRq requestID="${xmlEscape(requestID)}"/>`);
}

export function itemQueryRq(requestID = '1'): string {
  return wrapQbxml(`<ItemQueryRq requestID="${xmlEscape(requestID)}"/>`);
}

// --- Write request (BillAdd) — enqueued ONLY in write mode ------------------

export interface BillLine {
  accountFullName: string;
  amount: number; // dollars; formatted to 2dp
  memo?: string;
}

export interface BillAddInput {
  vendorName: string;
  refNumber?: string;
  txnDate?: string; // YYYY-MM-DD
  dueDate?: string; // YYYY-MM-DD
  memo?: string;
  lines: BillLine[];
}

function money(n: number): string {
  return n.toFixed(2);
}

/** Build a BillAddRq (a vendor bill). WRITE request — a real-books mutation. */
export function billAddRq(input: BillAddInput, requestID = '1'): string {
  const expenseLines = input.lines
    .map(
      (l) =>
        `    <ExpenseLineAdd>\n` +
        `      <AccountRef><FullName>${xmlEscape(l.accountFullName)}</FullName></AccountRef>\n` +
        `      <Amount>${money(l.amount)}</Amount>\n` +
        (l.memo ? `      <Memo>${xmlEscape(l.memo)}</Memo>\n` : '') +
        `    </ExpenseLineAdd>`,
    )
    .join('\n');
  const inner =
    `<BillAddRq requestID="${xmlEscape(requestID)}">\n` +
    `  <BillAdd>\n` +
    `    <VendorRef><FullName>${xmlEscape(input.vendorName)}</FullName></VendorRef>\n` +
    (input.txnDate ? `    <TxnDate>${xmlEscape(input.txnDate)}</TxnDate>\n` : '') +
    (input.dueDate ? `    <DueDate>${xmlEscape(input.dueDate)}</DueDate>\n` : '') +
    (input.refNumber ? `    <RefNumber>${xmlEscape(input.refNumber)}</RefNumber>\n` : '') +
    (input.memo ? `    <Memo>${xmlEscape(input.memo)}</Memo>\n` : '') +
    `${expenseLines}\n` +
    `  </BillAdd>\n` +
    `</BillAddRq>`;
  return wrapQbxml(inner);
}

// --- Write detection + parsing ---------------------------------------------

const WRITE_RQ_RE = /<[A-Za-z]+(Add|Mod|Del|Void)Rq[\s>]/;

/** True if the qbXML contains any mutating request (Add/Mod/Del/Void). */
export function isWriteRequest(qbxml: string): boolean {
  return WRITE_RQ_RE.test(qbxml);
}

export interface QbxmlStatus {
  requestID?: string;
  statusCode: string;
  statusSeverity: string;
  statusMessage: string;
}

export interface QbxmlParseResult {
  statuses: QbxmlStatus[];
  ok: boolean; // every response element has statusCode "0"
  raw: string;
}

/**
 * Parse a qbXML response envelope's status attributes. Deliberately regex-based
 * (no XML dep): QuickBooks always emits statusCode/statusSeverity/statusMessage
 * on each *Rs element, which is what we gate on. Row extraction for specific
 * entities is done by callers as needed.
 */
export function parseQbxmlResponse(xml: string): QbxmlParseResult {
  const statuses: QbxmlStatus[] = [];
  const rsRe = /<([A-Za-z]+Rs)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = rsRe.exec(xml)) !== null) {
    const attrs = m[2] ?? '';
    const code = /statusCode="([^"]*)"/.exec(attrs)?.[1];
    if (code === undefined) continue; // not a response element with a status
    statuses.push({
      requestID: /requestID="([^"]*)"/.exec(attrs)?.[1],
      statusCode: code,
      statusSeverity: /statusSeverity="([^"]*)"/.exec(attrs)?.[1] ?? '',
      statusMessage: /statusMessage="([^"]*)"/.exec(attrs)?.[1] ?? '',
    });
  }
  return { statuses, ok: statuses.length > 0 && statuses.every((s) => s.statusCode === '0'), raw: xml };
}
