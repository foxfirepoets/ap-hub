import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getPool } from '../db/pool.js';
import type { ProviderJob, ProviderJobOperation } from '../accounting/contracts.js';

type JobRow = pg.QueryResultRow & {
  id: string; tenant_id: string; connection_id: string; proposal_id: string | null;
  operation: ProviderJobOperation; request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown> | null; status: ProviderJob['status'];
  idempotency_key: string; lease_token: string | null; leased_at: Date | null;
  lease_expires_at: Date | null; attempts: number; error_code: string | null;
  error_detail: string | null; created_at: Date; updated_at: Date;
};

export class UnsafeProviderJobRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeProviderJobRetryError';
  }
}

export function stableProviderJobKey(input: {
  tenantId: number; connectionId: number; proposalId?: number | null;
  operation: ProviderJobOperation; sourceKey: string;
}): string {
  return createHash('sha256').update([
    input.tenantId, input.connectionId, input.proposalId ?? '-', input.operation, input.sourceKey,
  ].join(':')).digest('hex');
}

function mapJob(row: JobRow): ProviderJob {
  return {
    id: Number(row.id), tenantId: Number(row.tenant_id), connectionId: Number(row.connection_id),
    proposalId: row.proposal_id === null ? null : Number(row.proposal_id),
    operation: row.operation, requestPayload: row.request_payload,
    responsePayload: row.response_payload, status: row.status,
    idempotencyKey: row.idempotency_key, leaseToken: row.lease_token,
    leasedAt: row.leased_at, leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts, errorCode: row.error_code, errorDetail: row.error_detail,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * PostgreSQL is the sole QBD work authority. The transaction-level advisory lock
 * serializes leases by connection even when multiple app instances poll together.
 */
export class DurableProviderJobs {
  constructor(
    private readonly pool: pg.Pool = getPool(),
    private readonly leaseSeconds = Number(process.env.PROVIDER_JOB_LEASE_SECONDS ?? 300),
  ) {}

  async enqueue(input: {
    tenantId: number; connectionId: number; proposalId?: number | null;
    operation: ProviderJobOperation; requestPayload: Record<string, unknown>; sourceKey: string;
  }): Promise<ProviderJob> {
    const key = stableProviderJobKey(input);
    const { rows } = await this.pool.query<JobRow>(
      `INSERT INTO provider_jobs
         (tenant_id, connection_id, proposal_id, operation, request_payload, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, connection_id, idempotency_key, operation)
       DO UPDATE SET updated_at = provider_jobs.updated_at
       RETURNING *`,
      [input.tenantId, input.connectionId, input.proposalId ?? null, input.operation,
        input.requestPayload, key],
    );
    return mapJob(rows[0]!);
  }

  async list(tenantId: number): Promise<ProviderJob[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT * FROM provider_jobs WHERE tenant_id=$1 ORDER BY created_at,id`, [tenantId],
    );
    return rows.map(mapJob);
  }

  async leaseNext(input: {
    tenantId: number; connectionId: number; observedCompanyId: string;
  }): Promise<ProviderJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [input.connectionId]);

      const connection = await client.query<pg.QueryResultRow & {
        external_company: string | null; metadata: Record<string, unknown>; status: string;
      }>(
        `SELECT external_company,metadata,status FROM connections
          WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.connectionId],
      );
      const conn = connection.rows[0];
      if (!conn) {
        await client.query('ROLLBACK');
        return null;
      }

      // A sent job has an ambiguous provider outcome. Expiry must hold, never replay.
      await client.query(
        `UPDATE provider_jobs
            SET status='held', error_code='UNCERTAIN_OUTCOME',
                error_detail='lease expired after request was sent; provider query/adoption required',
                lease_token=NULL, leased_at=NULL, lease_expires_at=NULL, updated_at=now()
          WHERE tenant_id=$1 AND connection_id=$2 AND status='sent'
            AND lease_expires_at <= now()`,
        [input.tenantId, input.connectionId],
      );

      // A create whose transport outcome is unknown must never be replayed.  Turn
      // it into a durable duplicate probe instead; the parent remains held until
      // an authoritative BillQuery result is adopted atomically.
      const uncertain = await client.query<JobRow>(
        `SELECT * FROM provider_jobs
          WHERE tenant_id=$1 AND connection_id=$2 AND operation='post_bill'
            AND status='held' AND error_code='UNCERTAIN_OUTCOME'
          ORDER BY created_at,id FOR UPDATE`,
        [input.tenantId, input.connectionId],
      );
      for (const parent of uncertain.rows) {
        const sourceKey = `uncertain:${parent.id}:${parent.idempotency_key}`;
        const resolverKey = stableProviderJobKey({
          tenantId: input.tenantId,
          connectionId: input.connectionId,
          proposalId: parent.proposal_id === null ? null : Number(parent.proposal_id),
          operation: 'read_back',
          sourceKey,
        });
        await client.query(
          `INSERT INTO provider_jobs
             (tenant_id,connection_id,proposal_id,operation,request_payload,idempotency_key)
           VALUES ($1,$2,$3,'read_back',$4,$5)
           ON CONFLICT (tenant_id,connection_id,idempotency_key,operation) DO NOTHING`,
          [input.tenantId, input.connectionId, parent.proposal_id, {
            parentJobId: Number(parent.id),
            resolution: 'uncertain_duplicate_probe',
            txn: parent.request_payload.txn,
            expectedCompanyId: parent.request_payload.expectedCompanyId,
          }, resolverKey],
        );
      }
      await client.query(
        `UPDATE provider_jobs
            SET status='queued', lease_token=NULL, leased_at=NULL, lease_expires_at=NULL,
                error_code='LEASE_EXPIRED', error_detail='recovered before provider send',
                updated_at=now()
          WHERE tenant_id=$1 AND connection_id=$2 AND status='leased'
            AND lease_expires_at <= now()`,
        [input.tenantId, input.connectionId],
      );

      const expected = String(conn.metadata.expectedCompanyId ?? conn.external_company ?? '');
      if (conn.status !== 'active' || !expected || expected !== input.observedCompanyId) {
        await client.query(
          `UPDATE provider_jobs SET status='held', error_code='COMPANY_IDENTITY_MISMATCH',
             error_detail=$3, updated_at=now()
           WHERE tenant_id=$1 AND connection_id=$2 AND status='queued'`,
          [input.tenantId, input.connectionId,
            `expected ${expected || '(unconfigured)'}, observed ${input.observedCompanyId}`],
        );
        await client.query('COMMIT');
        return null;
      }

      const active = await client.query(
        `SELECT 1 FROM provider_jobs WHERE tenant_id=$1 AND connection_id=$2
          AND status IN ('leased','sent') AND lease_expires_at > now() LIMIT 1`,
        [input.tenantId, input.connectionId],
      );
      if (active.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const token = randomUUID();
      const { rows } = await client.query<JobRow>(
        `WITH candidate AS (
           SELECT id FROM provider_jobs
            WHERE tenant_id=$1 AND connection_id=$2 AND status='queued'
            ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE provider_jobs j SET status='leased', lease_token=$3, leased_at=now(),
           lease_expires_at=now()+($4 * interval '1 second'), attempts=attempts+1,
           error_code=NULL,error_detail=NULL,updated_at=now()
         FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
        [input.tenantId, input.connectionId, token, this.leaseSeconds],
      );
      await client.query('COMMIT');
      return rows[0] ? mapJob(rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markSent(tenantId: number, jobId: number, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE provider_jobs SET status='sent',updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='leased' AND lease_token=$3`,
      [tenantId, jobId, leaseToken],
    );
    return result.rowCount === 1;
  }

  async complete(input: {
    tenantId: number; jobId: number; leaseToken: string;
    responsePayload: Record<string, unknown>;
  }): Promise<ProviderJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE provider_jobs SET status='succeeded',response_payload=$4,
         lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,
         error_code=NULL,error_detail=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status='sent' AND lease_token=$3
       RETURNING *`,
      [input.tenantId, input.jobId, input.leaseToken, input.responsePayload],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async fail(input: {
    tenantId: number; jobId: number; leaseToken: string;
    errorCode: string; errorDetail: string; outcomeKnown: boolean;
  }): Promise<ProviderJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE provider_jobs SET status=$4,error_code=$5,error_detail=$6,
         lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status='sent' AND lease_token=$3
       RETURNING *`,
      [input.tenantId, input.jobId, input.leaseToken,
        input.outcomeKnown ? 'failed' : 'held',
        input.outcomeKnown ? input.errorCode : 'UNCERTAIN_OUTCOME', input.errorDetail],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async hold(input: {
    tenantId: number; jobId: number; leaseToken: string;
    errorCode: string; errorDetail: string; responsePayload?: Record<string, unknown>;
  }): Promise<ProviderJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE provider_jobs SET status='held',response_payload=COALESCE($6,response_payload),
         error_code=$4,error_detail=$5,lease_token=NULL,leased_at=NULL,
         lease_expires_at=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status='sent' AND lease_token=$3
       RETURNING *`,
      [input.tenantId, input.jobId, input.leaseToken, input.errorCode,
        input.errorDetail, input.responsePayload ?? null],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  /**
   * A successful BillAdd response proves only that Desktop acknowledged the
   * create. Persist that acknowledgement and a durable BillQuery as one commit.
   */
  async acknowledgeCreateAndQueueReadBack(input: {
    tenantId: number; connectionId: number; proposalId: number;
    jobId: number; leaseToken: string; externalId: string; revision: string;
    providerResponse: Record<string, unknown>; txn: Record<string, unknown>;
    expectedCompanyId: string;
  }): Promise<ProviderJob> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const parent = await client.query<JobRow>(
        `SELECT * FROM provider_jobs
          WHERE tenant_id=$1 AND connection_id=$2 AND id=$3
            AND proposal_id=$4 AND operation='post_bill'
          FOR UPDATE`,
        [input.tenantId, input.connectionId, input.jobId, input.proposalId],
      );
      const row = parent.rows[0];
      if (!row || row.status !== 'sent' || row.lease_token !== input.leaseToken) {
        throw new UnsafeProviderJobRetryError('stale or conflicting BillAdd acknowledgement');
      }
      const sourceKey = `create-read-back:${row.id}:${input.externalId}`;
      const key = stableProviderJobKey({
        tenantId: input.tenantId, connectionId: input.connectionId,
        proposalId: input.proposalId, operation: 'read_back', sourceKey,
      });
      const queued = await client.query<JobRow>(
        `INSERT INTO provider_jobs
           (tenant_id,connection_id,proposal_id,operation,request_payload,idempotency_key)
         VALUES ($1,$2,$3,'read_back',$4,$5)
         ON CONFLICT (tenant_id,connection_id,idempotency_key,operation)
         DO UPDATE SET updated_at=provider_jobs.updated_at
         RETURNING *`,
        [input.tenantId, input.connectionId, input.proposalId, {
          parentJobId: input.jobId,
          resolution: 'create_read_back',
          externalId: input.externalId,
          createRevision: input.revision,
          txn: input.txn,
          expectedCompanyId: input.expectedCompanyId,
        }, key],
      );
      await client.query(
        `UPDATE provider_jobs SET status='succeeded',response_payload=$4,
           lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,
           error_code=NULL,error_detail='awaiting authoritative read-back',updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='sent' AND lease_token=$3`,
        [input.tenantId, input.jobId, input.leaseToken, input.providerResponse],
      );
      await client.query('COMMIT');
      return mapJob(queued.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Complete a pre-create duplicate probe and enqueue exactly one next stage. */
  async completePreflight(input: {
    tenantId: number; connectionId: number; proposalId: number; jobId: number;
    leaseToken: string; txn: Record<string, unknown>; expectedCompanyId: string;
    existing?: { externalId: string; revision: string };
    providerResponse: Record<string, unknown>;
  }): Promise<ProviderJob> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const probe = (await client.query<JobRow>(
        `SELECT * FROM provider_jobs WHERE tenant_id=$1 AND connection_id=$2 AND id=$3
          AND proposal_id=$4 AND operation='query' FOR UPDATE`,
        [input.tenantId, input.connectionId, input.jobId, input.proposalId],
      )).rows[0];
      if (!probe || probe.status !== 'sent' || probe.lease_token !== input.leaseToken) {
        throw new UnsafeProviderJobRetryError('stale preflight lease');
      }
      const operation: ProviderJobOperation = input.existing ? 'read_back' : 'post_bill';
      const sourceKey = input.existing
        ? `preexisting:${probe.id}:${input.existing.externalId}`
        : `preflight-create:${probe.id}`;
      const key = stableProviderJobKey({
        tenantId: input.tenantId, connectionId: input.connectionId,
        proposalId: input.proposalId, operation, sourceKey,
      });
      const next = await client.query<JobRow>(
        `INSERT INTO provider_jobs
          (tenant_id,connection_id,proposal_id,operation,request_payload,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,connection_id,idempotency_key,operation)
         DO UPDATE SET updated_at=provider_jobs.updated_at RETURNING *`,
        [input.tenantId, input.connectionId, input.proposalId, operation, {
          parentJobId: input.jobId,
          resolution: input.existing ? 'preexisting_adoption' : 'preflight_create',
          txn: input.txn,
          expectedCompanyId: input.expectedCompanyId,
          ...(input.existing ? {
            externalId: input.existing.externalId,
            createRevision: input.existing.revision,
          } : {}),
        }, key],
      );
      await client.query(
        `UPDATE provider_jobs SET status='succeeded',response_payload=$4,
          lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,error_code=NULL,
          error_detail=$5,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='sent' AND lease_token=$3`,
        [input.tenantId, input.jobId, input.leaseToken, input.providerResponse,
          input.existing ? 'existing bill found; awaiting authoritative adoption' : 'no duplicate found'],
      );
      await client.query('COMMIT');
      return mapJob(next.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Resolve an ambiguous create only after a provider query found the existing bill. */
  async adoptUncertain(input: {
    tenantId: number; jobId: number; externalId: string; revision: string;
    providerResponse: Record<string, unknown>;
  }): Promise<ProviderJob | null> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE provider_jobs SET status='succeeded',
         response_payload=$3,error_code=NULL,
         error_detail='adopted after provider duplicate query',
         lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status='held' AND error_code='UNCERTAIN_OUTCOME'
       RETURNING *`,
      [input.tenantId, input.jobId, {
        ...input.providerResponse, adopted: true,
        externalId: input.externalId, revision: input.revision,
      }],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async retry(tenantId: number, jobId: number): Promise<ProviderJob | null> {
    const updated = await this.pool.query<JobRow>(
      `UPDATE provider_jobs SET status='queued',lease_token=NULL,leased_at=NULL,
         lease_expires_at=NULL,error_code=NULL,error_detail=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status IN ('failed','held')
         AND error_code IS DISTINCT FROM 'UNCERTAIN_OUTCOME'
       RETURNING *`, [tenantId, jobId],
    );
    if (updated.rows[0]) return mapJob(updated.rows[0]);
    const { rows } = await this.pool.query<JobRow>(
      `SELECT * FROM provider_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, jobId],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.status === 'sent' || row.error_code === 'UNCERTAIN_OUTCOME') {
      throw new UnsafeProviderJobRetryError('uncertain provider outcome requires query/adoption before retry');
    }
    throw new UnsafeProviderJobRetryError(`job in ${row.status} state is not retryable`);
  }
}
