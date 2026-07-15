// Response shapes the UI consumes. These MIRROR the gate-covered service return types in
// src/services/read/* (which the API routes serialize). They are re-declared here — not
// imported — because these client modules must not pull server-only code (pg, config) into
// the browser bundle. Type declarations only; no logic lives here.

export interface Me {
  email: string;
  role: string;
  tenantId: number;
}

export interface TodayCounts {
  exceptions: number;
  posted: number;
  held: number;
  failed: number;
}

export interface TodayItem {
  proposalId: number;
  status: string;
  confidence: number;
  vendor: string | null;
  total: string | null;
  docNumber: string | null;
  sourceFilename: string | null;
  emailSubject: string | null;
  createdAt: string;
}

export interface TodayDigest {
  tenantId: number;
  generatedAt: string;
  counts: TodayCounts;
  items: TodayItem[];
}

export interface ExceptionRow {
  id: number;
  entityRef: string | null;
  reasonCode: string;
  detail: string | null;
  status: string;
  resolvedBy: string | null;
  resolution: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

export type UxStatus = 'prepared' | 'held' | 'posted' | 'reconciled' | 'rejected' | 'exception';

export interface TransactionRow {
  proposalId: number;
  status: UxStatus;
  rawStatus: string;
  confidence: number;
  vendor: string | null;
  total: string | null;
  docNumber: string | null;
  txnDate: string | null;
  postingId: number | null;
  qboType: string | null;
  qboId: string | null;
  qboLink: string | null;
  reconciled: boolean;
  createdAt: string;
}

export interface EvidenceEmail {
  messageId: number;
  gmailMessageId: string | null;
  subject: string | null;
  from: string | null;
  receivedAt: string | null;
}

export interface EvidenceAttachment {
  attachmentId: number;
  filename: string | null;
  sha256: string;
  mime: string | null;
}

export interface EvidenceExtraction {
  extractionId: number;
  fields: Record<string, unknown>;
  confidence: number;
  missingFields: string[];
  flags: string[];
}

export interface EvidencePriorRule {
  mappingId: number;
  kind: string;
  sourceKey: string;
  targetQboType: string | null;
  targetQboId: string | null;
  targetName: string | null;
  learnedFrom: string | null;
}

export interface EvidenceProof {
  product: string;
  entityKind: string;
  verdict: string | null;
  proofId: string | null;
  chainHash: string | null;
}

export interface EvidencePosting {
  postingId: number;
  qboType: string | null;
  qboId: string | null;
  status: string;
}

export interface Evidence {
  proposalId: number;
  status: string;
  confidence: number;
  email: EvidenceEmail | null;
  attachment: EvidenceAttachment | null;
  extraction: EvidenceExtraction | null;
  priorRule: EvidencePriorRule | null;
  proofs: EvidenceProof[];
  posting: EvidencePosting | null;
  qboLink: string | null;
  missing: string[];
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  entity: string | null;
  realm: string | null;
  detail: unknown;
  at: string;
}

// The shape returned by POST /api/proposals/:id/approve on success (201).
export interface ApprovePosted {
  posting_id: number;
  qbo_type: string;
  qbo_id: string;
  qbo_link: string | null;
  mode: string;
}

// CHUNK_6_ONBOARDING — mirrors src/services/onboarding.ts return shapes.
export interface OnboardingConnections {
  gmailConnected: boolean;
  gmailScopeOk: boolean;
  qboConnected: boolean;
  qboCompanySelected: boolean;
  qboCompanyName: string | null;
}

export interface SetupBlocker {
  code: string;
  group: string;
  message: string;
  fix: string;
}

export interface OnboardingPriorData {
  emails: number;
  invoices: number;
  vendorsKnown: number;
}

export interface OnboardingState {
  step: string;
  dryRunComplete: boolean;
  automationLevel: string;
  updatedAt: string | null;
  connections: OnboardingConnections;
  blockers: SetupBlocker[];
  priorData: OnboardingPriorData;
}

export interface DryRunSummary {
  emailsScanned: number;
  invoicesFound: number;
  vendorsMatched: number;
  proposalsCreated: number;
}
