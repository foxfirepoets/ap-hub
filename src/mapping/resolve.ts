/**
 * Mapping resolver (CHUNK_6). Vendor via exact-prior-mapping → normalized fuzzy match
 * → else unknown_vendor. Transaction type by rule (never a Journal Entry). Account and
 * dimension via config rules. Pure functions — the DB lookups are injected as candidate
 * lists so this is fully unit-testable.
 */

export interface VendorCandidate {
  sourceKey: string;
  targetId: string;
  targetName: string;
}
export interface AccountCandidate {
  key: string; // normalized hint/keyword
  targetId: string;
  targetName: string;
}
export interface DimensionCandidate {
  kind: 'class' | 'location' | 'project';
  key: string;
  targetId: string;
  targetName: string;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(llc|inc|ltd|corp|co|company|the)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  const dist = levenshtein(na, nb);
  const lev = 1 - dist / maxLen;
  // token overlap
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const overlap = inter / Math.max(ta.size, tb.size);
  return Math.max(lev, overlap);
}

export type VendorResolution =
  | { status: 'exact' | 'fuzzy'; targetId: string; targetName: string; confidence: number }
  | { status: 'unknown' };

export function resolveVendor(
  vendorName: string | null,
  senderDomain: string | null,
  candidates: VendorCandidate[],
  fuzzyThreshold = 0.82,
): VendorResolution {
  if (!vendorName && !senderDomain) return { status: 'unknown' };

  // Exact prior mapping on normalized name or sender domain.
  const keyName = vendorName ? normalize(vendorName) : '';
  for (const c of candidates) {
    if (
      (keyName && normalize(c.sourceKey) === keyName) ||
      (senderDomain && c.sourceKey.toLowerCase() === senderDomain.toLowerCase())
    ) {
      return { status: 'exact', targetId: c.targetId, targetName: c.targetName, confidence: 1 };
    }
  }

  // Fuzzy against candidate names.
  if (vendorName) {
    let best: { c: VendorCandidate; score: number } | null = null;
    for (const c of candidates) {
      const score = similarity(vendorName, c.targetName || c.sourceKey);
      if (!best || score > best.score) best = { c, score };
    }
    if (best && best.score >= fuzzyThreshold) {
      return { status: 'fuzzy', targetId: best.c.targetId, targetName: best.c.targetName, confidence: best.score };
    }
  }
  return { status: 'unknown' };
}

export type TxnType = 'Bill' | 'Purchase' | 'Invoice' | 'SalesReceipt';

export function routeTxnType(docType: string, direction: string, paidNow: boolean): TxnType {
  if (direction === 'AR') return paidNow || docType === 'receipt' ? 'SalesReceipt' : 'Invoice';
  // AP
  return paidNow || docType === 'receipt' ? 'Purchase' : 'Bill';
}

export function resolveAccount(
  hint: string | null,
  lineDescriptions: string[],
  candidates: AccountCandidate[],
): AccountCandidate | null {
  const keys = [hint, ...lineDescriptions].filter(Boolean).map((s) => normalize(String(s)));
  for (const c of candidates) {
    if (keys.some((k) => k.includes(c.key) || c.key.includes(k))) return c;
  }
  return null;
}
