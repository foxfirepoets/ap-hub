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

// CHUNK_7_DIGEST — mirrors src/services/read/notifications.ts's NotificationRow.
export interface NotificationRow {
  id: number;
  kind: string; // daily_digest | risk_alert
  severity: string; // info | high | critical
  payload: Record<string, unknown>;
  digestBatch: string | null;
  readAt: string | null;
  createdAt: string;
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

// F_DIMENSION_MAPPING_UI — mirrors app/api/dimension-mappings response shapes
// (src/services/action/dimensionMappings.ts's mappingJson()). Re-declared here (not
// imported) per this file's client/server boundary convention above.
export type DimensionType =
  | 'account'
  | 'item'
  | 'class'
  | 'location'
  | 'department'
  | 'customer'
  | 'project'
  | 'job'
  | 'tracking_category'
  | 'entity'
  | 'tax_code'
  | 'currency';

export type DimensionReviewStatus = 'pending' | 'accepted' | 'corrected' | 'rejected' | 'held';

export type DimensionResolutionState =
  | 'mapped'
  | 'not_provided'
  | 'not_mapped'
  | 'unsupported_by_provider'
  | 'intentionally_blank';

export interface DimensionMappingRow {
  id: number;
  connection_id: number;
  provider: string;
  proposal_id: number;
  dimension_type: DimensionType;
  raw_value: string;
  normalized_value: string | null;
  source_evidence: Record<string, unknown>;
  extraction_confidence: number;
  proposed_provider_id: string | null;
  proposed_match_label: string | null;
  provider_id: string | null;
  mapping_method: string | null;
  review_status: DimensionReviewStatus;
  resolution_state: DimensionResolutionState;
  active: boolean;
  mapping_version: number;
  revalidated_at: string | null;
  created_at: string;
  updated_at: string;
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

// F_TAX_MAPPING_API — mirrors app/api/tax-mappings/**'s mappingJson() EXACTLY (snake_case,
// unlike the camelCase read-service types above) since that action bridge serializes the
// DB row directly with no intermediate camelCase transform.
export interface TaxMapping {
  id: number;
  connection_id: number;
  provider: string;
  provider_tax_code: string;
  internal_tax_treatment: string;
  tax_mode: 'exclusive' | 'inclusive';
  applies_at: 'invoice' | 'line';
  active: boolean;
  needs_revalidation: boolean;
  superseded_by_id: number | null;
  replaced_at: string | null;
  created_at: string;
  updated_at: string;
}

// GET /api/tax-mappings/:id/audit — mirrors app/api/tax-mappings/[id]/audit's auditRowJson()
// (snake_case, same convention as TaxMapping above). `reason` is the domain-specific "why"
// that GET /api/audit's generic AuditRow cannot carry.
export interface TaxMappingAudit {
  id: number;
  tax_mapping_id: number;
  connection_id: number;
  provider: string;
  changed_by: number | null;
  action: string;
  reason: string | null;
  changed_at: string;
}

// GET /api/tax-mappings/discover — read-only QBO TaxCode rows (src/mapping/taxCodeDiscovery.ts).
export interface QboTaxCode {
  Id: string;
  Name?: string;
  Description?: string;
  Active?: boolean;
}

export interface ProviderCapability {
  provider: string;
  edition: string;
  operation: string;
  supported: boolean;
  reason: string | null;
  unsupportedFields: string[];
}

export interface ProviderCapabilityConnection {
  id: number;
  provider: string;
  connectionClass: string;
  displayName: string | null;
  externalCompany: string | null;
  status: string;
  lastVerifiedAt: string | null;
  writeGateEnabled: boolean | null;
  expectedCompanyId: string | null;
  observedCompanyId: string | null;
  lastContactAt: string | null;
  edition: string;
  supported: boolean;
  capabilities: ProviderCapability[];
  gaps: string[];
}

export interface ConnectionStatus {
  id: number;
  provider: string;
  connectionClass: string;
  displayName: string | null;
  externalCompany: string | null;
  status: string;
  updatedAt: string;
}

export interface ProviderJob {
  id: number;
  connectionId: number;
  operation: string;
  status: string;
  attempts: number;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatementListItem {
  id: number;
  institutionName: string | null;
  accountHint: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: 'extracted' | 'unbalanced' | 'review' | 'ready' | 'filed' | 'held';
  filedAt: string | null;
  lineCount: number;
  unresolvedCount: number;
}

export interface StatementLine {
  id: number;
  lineNo: number;
  postedOn: string | null;
  description: string;
  amount: string;
  balance: string | null;
  matchStatus: 'unmatched' | 'suggested' | 'matched' | 'excluded';
  matchedProviderRef: Record<string, unknown> | null;
  reviewReason: string | null;
}

export interface StatementDetail extends StatementListItem {
  documentId: number;
  currency: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  validationDetail: Record<string, unknown>;
  lines: StatementLine[];
}

export interface ClassificationReviewItem {
  id: number;
  messageId: number;
  attachmentId: number | null;
  filename: string | null;
  subject: string | null;
  holdReason: string | null;
  createdAt: string;
}
