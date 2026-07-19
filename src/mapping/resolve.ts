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

/**
 * Vendor resolution. The `status`/`targetId`/`targetName`/`confidence` fields are the
 * long-standing contract; the F5 fields (matchType, reasons, conflicts, candidateCount,
 * ambiguous) are additive metadata the vendor-review gate uses to decide auto vs review.
 * Determinism is by explicit gate, not by score alone: only an unambiguous exact match
 * auto-posts; fuzzy / ambiguous-exact / multiple-candidate are surfaced for review.
 */
export type VendorMatchType = 'normalized_name' | 'sender_domain' | 'fuzzy';
export type VendorResolution =
  | {
      status: 'exact' | 'fuzzy';
      targetId: string;
      targetName: string;
      confidence: number;
      matchType?: VendorMatchType;
      reasons?: string[];
      conflicts?: { targetId: string; targetName: string }[];
      candidateCount?: number;
      ambiguous?: boolean;
    }
  | { status: 'unknown'; reasons?: string[]; candidateCount?: number };

export function resolveVendor(
  vendorName: string | null,
  senderDomain: string | null,
  candidates: VendorCandidate[],
  fuzzyThreshold = 0.82,
): VendorResolution {
  if (!vendorName && !senderDomain) return { status: 'unknown', reasons: ['no_vendor_signal'], candidateCount: 0 };

  // Exact prior mapping on normalized name or sender domain.
  const keyName = vendorName ? normalize(vendorName) : '';
  const exact: { c: VendorCandidate; via: VendorMatchType }[] = [];
  for (const c of candidates) {
    if (keyName && normalize(c.sourceKey) === keyName) exact.push({ c, via: 'normalized_name' });
    else if (senderDomain && c.sourceKey.toLowerCase() === senderDomain.toLowerCase()) exact.push({ c, via: 'sender_domain' });
  }
  if (exact.length > 0) {
    const distinct = [...new Map(exact.map((e) => [e.c.targetId, e.c])).values()];
    const first = exact[0]!;
    const ambiguous = distinct.length > 1;
    return {
      status: 'exact',
      targetId: first.c.targetId,
      targetName: first.c.targetName,
      confidence: 1,
      matchType: first.via,
      reasons: ambiguous ? ['exact_name', 'multiple_conflicting_targets'] : ['exact_name'],
      conflicts: ambiguous ? distinct.map((c) => ({ targetId: c.targetId, targetName: c.targetName })) : undefined,
      candidateCount: distinct.length,
      ambiguous,
    };
  }

  // Fuzzy against candidate names.
  if (vendorName) {
    const scored = candidates
      .map((c) => ({ c, score: similarity(vendorName, c.targetName || c.sourceKey) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0] ?? null;
    if (best && best.score >= fuzzyThreshold) {
      const contenders = scored.filter((s) => s.score >= fuzzyThreshold && s.c.targetId !== best.c.targetId);
      const reasons = ['fuzzy_name_match'];
      if (contenders.length > 0) reasons.push('multiple_candidates');
      return {
        status: 'fuzzy',
        targetId: best.c.targetId,
        targetName: best.c.targetName,
        confidence: best.score,
        matchType: 'fuzzy',
        reasons,
        conflicts: contenders.length > 0 ? contenders.map((s) => ({ targetId: s.c.targetId, targetName: s.c.targetName })) : undefined,
        candidateCount: scored.filter((s) => s.score >= fuzzyThreshold).length,
      };
    }
  }
  return { status: 'unknown', reasons: ['no_match'], candidateCount: 0 };
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
