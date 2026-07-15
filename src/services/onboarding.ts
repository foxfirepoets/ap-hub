import { scopedQuery } from '../db/scoped.js';
import { query } from '../db/pool.js';
import { proposeOnce, type ProposeDeps } from '../pipeline/mapping.js';
import { ensurePermission, withAudit, ServiceError, type ActorContext } from './index.js';

/**
 * CHUNK_6_ONBOARDING — first-run wizard state, discovery, and the dry-run scan.
 *
 * The dry-run reuses the EXISTING `proposeOnce` (`src/pipeline/mapping.ts`) — the same
 * function the live `propose` job calls — with no `enqueuePost` dependency, so it can
 * never reach `post_sandbox` / `src/qbo/write.ts` (guarantee 1). `assertNotDryRunLocked`
 * is the DRY_RUN_LOCKED gate: `approveProposal`/`retryProposal` call it before posting,
 * so no post can occur until a human explicitly sets `automation_level` away from 'off'.
 */

export const ONBOARDING_STEPS = [
  'connect_gmail',
  'connect_qbo',
  'select_company',
  'configure_mode',
  'automation_level',
  'dry_run',
  'review_sample',
  'approve_rules',
  'complete',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const AUTOMATION_LEVELS = ['off', 'assisted', 'auto'] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

export interface OnboardingRow {
  step: string;
  dryRunComplete: boolean;
  automationLevel: string;
  updatedAt: string | null;
}

export interface ConnectionStatus {
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

export interface PriorDataCounts {
  emails: number;
  invoices: number;
  vendorsKnown: number;
}

export interface OnboardingStateView extends OnboardingRow {
  connections: ConnectionStatus;
  blockers: SetupBlocker[];
  priorData: PriorDataCounts;
}

async function readRow(tenantId: number): Promise<OnboardingRow> {
  const { rows } = await scopedQuery<{
    step: string;
    dry_run_complete: boolean;
    automation_level: string;
    updated_at: Date | null;
  }>(tenantId, 'SELECT step, dry_run_complete, automation_level, updated_at FROM onboarding_state WHERE tenant_id=$1');
  const r = rows[0];
  return {
    step: r?.step ?? 'connect_gmail',
    dryRunComplete: r?.dry_run_complete ?? false,
    automationLevel: r?.automation_level ?? 'off',
    updatedAt: r?.updated_at ? r.updated_at.toISOString() : null,
  };
}

/** Idempotent: first touch of onboarding creates the row (defaults apply). */
async function ensureRow(tenantId: number): Promise<void> {
  await scopedQuery(tenantId, 'INSERT INTO onboarding_state (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING');
}

/** Discovery-before-asking: read what Gmail/QBO/prior-data already show before prompting. */
async function readConnections(tenantId: number): Promise<ConnectionStatus> {
  // `tenants` has no `tenant_id` column (its own PK IS the tenant id) — scopedQuery's
  // tenant_id-reference check doesn't apply; the WHERE id=$1 IS the tenant scope.
  const tenantRow = (
    await query<{ qbo_realm_id: string | null }>('SELECT qbo_realm_id FROM tenants WHERE id=$1', [tenantId])
  ).rows[0];
  const tokens = (
    await scopedQuery<{ provider: string; scope: string | null; realm: string | null }>(
      tenantId,
      'SELECT provider, scope, realm FROM oauth_tokens WHERE tenant_id=$1',
    )
  ).rows;
  const gmailTok = tokens.find((t) => t.provider === 'gmail');
  const qboTok = tokens.find((t) => t.provider === 'qbo');
  const gmailConnected = Boolean(gmailTok);
  const gmailScopeOk = gmailConnected ? (gmailTok!.scope ?? '').includes('gmail.readonly') : false;
  const qboConnected = Boolean(qboTok);
  const qboCompanySelected = Boolean(tenantRow?.qbo_realm_id ?? qboTok?.realm);
  return {
    gmailConnected,
    gmailScopeOk,
    qboConnected,
    qboCompanySelected,
    qboCompanyName: tenantRow?.qbo_realm_id ?? qboTok?.realm ?? null,
  };
}

/** Setup blockers as grouped, exact-fix cards (acceptance criterion). */
function deriveBlockers(c: ConnectionStatus): SetupBlocker[] {
  const blockers: SetupBlocker[] = [];
  if (!c.gmailConnected) {
    blockers.push({
      code: 'gmail_not_connected',
      group: 'Gmail',
      message: 'Gmail is not connected.',
      fix: 'Connect Gmail to continue.',
    });
  } else if (!c.gmailScopeOk) {
    blockers.push({
      code: 'gmail_scope_denied',
      group: 'Gmail',
      message: 'Gmail was connected without the required read scope.',
      fix: 'Reconnect Gmail with label access.',
    });
  }
  if (!c.qboConnected) {
    blockers.push({
      code: 'qbo_not_connected',
      group: 'QuickBooks',
      message: 'QuickBooks Online is not connected.',
      fix: 'Connect QuickBooks Online (sandbox) to continue.',
    });
  } else if (!c.qboCompanySelected) {
    blockers.push({
      code: 'qbo_company_unselected',
      group: 'QuickBooks',
      message: 'No QuickBooks sandbox company is selected.',
      fix: 'Select a QuickBooks company (sandbox) to continue.',
    });
  }
  return blockers;
}

async function readPriorData(tenantId: number): Promise<PriorDataCounts> {
  const { rows } = await scopedQuery<{ emails: number; invoices: number; vendors: number }>(
    tenantId,
    `SELECT
       (SELECT count(*)::int FROM messages WHERE tenant_id=$1) AS emails,
       (SELECT count(*)::int FROM extractions e WHERE e.tenant_id=$1 AND (e.fields->>'doc_type')='invoice') AS invoices,
       (SELECT count(*)::int FROM mappings WHERE tenant_id=$1 AND kind='vendor') AS vendors`,
  );
  const r = rows[0];
  return { emails: r?.emails ?? 0, invoices: r?.invoices ?? 0, vendorsKnown: r?.vendors ?? 0 };
}

/** GET /api/onboarding — current state + discovery (any authenticated role may view). */
export async function getOnboardingState(ctx: ActorContext): Promise<OnboardingStateView> {
  ensurePermission(ctx, 'read');
  const [row, connections, priorData] = await Promise.all([
    readRow(ctx.tenantId),
    readConnections(ctx.tenantId),
    readPriorData(ctx.tenantId),
  ]);
  return { ...row, connections, blockers: deriveBlockers(connections), priorData };
}

export interface AdvanceStepInput {
  step?: string;
  automationLevel?: string;
}

/** POST /api/onboarding/step — advance the wizard step and/or persist a choice. */
export async function advanceOnboardingStep(ctx: ActorContext, input: AdvanceStepInput): Promise<OnboardingRow> {
  ensurePermission(ctx, 'onboard');
  if (input.step !== undefined && !(ONBOARDING_STEPS as readonly string[]).includes(input.step)) {
    throw new ServiceError('VALIDATION', `unknown onboarding step "${input.step}"`);
  }
  if (input.automationLevel !== undefined && !(AUTOMATION_LEVELS as readonly string[]).includes(input.automationLevel)) {
    throw new ServiceError('VALIDATION', `unknown automation level "${input.automationLevel}"`);
  }
  return withAudit(
    ctx,
    'onboarding.step',
    `tenant:${ctx.tenantId}`,
    async () => {
      await ensureRow(ctx.tenantId);
      await scopedQuery(
        ctx.tenantId,
        `UPDATE onboarding_state
            SET step = COALESCE($2, step),
                automation_level = COALESCE($3, automation_level),
                updated_at = now()
          WHERE tenant_id = $1`,
        [input.step ?? null, input.automationLevel ?? null],
      );
      return readRow(ctx.tenantId);
    },
    (r) => ({ step: r.step, automationLevel: r.automationLevel }),
  );
}

/**
 * The DRY_RUN_LOCKED guard: `automation_level` defaults to 'off'. A tenant that never
 * touched onboarding (no row) is NOT locked — pre-onboarding tenants and existing
 * CHUNK_2/4 callers keep working unchanged. Only once onboarding has started does the
 * gate apply, until a human explicitly sets automation_level away from 'off'.
 */
export async function isDryRunLocked(tenantId: number): Promise<boolean> {
  const { rows } = await scopedQuery<{ automation_level: string }>(
    tenantId,
    'SELECT automation_level FROM onboarding_state WHERE tenant_id=$1',
  );
  const row = rows[0];
  if (!row) return false;
  return !row.automation_level || row.automation_level === 'off';
}

export async function assertNotDryRunLocked(tenantId: number): Promise<void> {
  if (await isDryRunLocked(tenantId)) {
    throw new ServiceError(
      'dry_run_locked',
      'automation is off — posting is locked until onboarding sets automation_level away from "off"',
    );
  }
}

export interface DryRunSummary {
  emailsScanned: number;
  invoicesFound: number;
  vendorsMatched: number;
  proposalsCreated: number;
}

export interface DryRunDeps {
  scan: ProposeDeps['scan'];
}

async function defaultDryRunDeps(): Promise<DryRunDeps> {
  const { swarmsync } = await import('../services.js');
  return { scan: (input) => swarmsync().scanInvoices(input) };
}

/**
 * POST /api/onboarding/dry-run — runs the pipeline through `propose` ONLY (no
 * `enqueuePost`), so it structurally can never post (guarantee 1). Proposes every
 * extraction that does not yet have a proposal for this tenant, then returns a
 * business-specific summary (never a blank dashboard).
 */
export async function runOnboardingDryRun(ctx: ActorContext, deps?: DryRunDeps): Promise<DryRunSummary> {
  ensurePermission(ctx, 'onboard');
  return withAudit(
    ctx,
    'onboarding.dry_run',
    `tenant:${ctx.tenantId}`,
    async () => {
      await ensureRow(ctx.tenantId);
      const { config } = await import('../config.js');
      const cfg = config();
      const d = deps ?? (await defaultDryRunDeps());

      const pending = (
        await scopedQuery<{ id: number; attachment_id: number | null; message_id: number }>(
          ctx.tenantId,
          `SELECT e.id, e.attachment_id, e.message_id
             FROM extractions e
        LEFT JOIN proposals p ON p.tenant_id = e.tenant_id AND p.attachment_id = e.attachment_id
            WHERE e.tenant_id = $1 AND p.id IS NULL`,
        )
      ).rows;

      let proposalsCreated = 0;
      for (const row of pending) {
        // No `enqueuePost` dependency here — the dry run NEVER reaches post_sandbox.
        const outcome = await proposeOnce(
          ctx.tenantId,
          { tenantId: ctx.tenantId, extractionId: row.id, attachmentId: row.attachment_id, messageId: row.message_id },
          { scan: d.scan, autoThreshold: cfg.AUTO_THRESHOLD, reviewThreshold: cfg.REVIEW_THRESHOLD },
        );
        if (outcome) proposalsCreated += 1;
      }

      await scopedQuery(
        ctx.tenantId,
        'UPDATE onboarding_state SET dry_run_complete = true, updated_at = now() WHERE tenant_id = $1',
      );

      const summary = (
        await scopedQuery<{ emails: number; invoices: number; vendors: number }>(
          ctx.tenantId,
          `SELECT
             (SELECT count(*)::int FROM messages WHERE tenant_id=$1) AS emails,
             (SELECT count(*)::int FROM proposals WHERE tenant_id=$1) AS invoices,
             (SELECT count(DISTINCT proposed_txn->'vendorRef'->>'value')::int
                FROM proposals
               WHERE tenant_id=$1 AND proposed_txn->'vendorRef'->>'value' IS NOT NULL) AS vendors`,
        )
      ).rows[0]!;

      return {
        emailsScanned: summary.emails,
        invoicesFound: summary.invoices,
        vendorsMatched: summary.vendors,
        proposalsCreated,
      };
    },
    (r) => ({ proposalsCreated: r.proposalsCreated, invoicesFound: r.invoicesFound }),
  );
}
