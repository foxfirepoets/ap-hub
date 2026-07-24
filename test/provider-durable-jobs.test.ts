import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query } from '../src/db/pool.js';
import { createSession } from '../src/auth/session.js';
import {
  DurableProviderJobs,
  UnsafeProviderJobRetryError,
  stableProviderJobKey,
} from '../src/qbdesktop/durable-jobs.js';
import { closeAll, createConnection, createTenant, createUser, resetTables } from './helpers.js';
import { GET as listJobs } from '../app/api/provider-jobs/route.js';
import { POST as retryJob } from '../app/api/provider-jobs/[id]/retry/route.js';

async function desktopConnection(tenantId: number, companyId: string): Promise<number> {
  const id = await createConnection(tenantId, {
    provider: 'qbd',
    connectionClass: 'local_desktop',
    externalCompany: companyId,
  });
  await query(
    `UPDATE connections SET metadata=$1 WHERE tenant_id=$2 AND id=$3`,
    [{ edition: 'enterprise', platform: 'windows', expectedCompanyId: companyId }, tenantId, id],
  );
  return id;
}

describe.sequential('CHUNK_2_DURABLE_JOBS — real PostgreSQL authority', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('persists stable-idempotency work across service restart', async () => {
    const tenant = await createTenant('restart');
    const connection = await desktopConnection(tenant, 'company-a');
    const firstProcess = new DurableProviderJobs(getPool(), 60);
    const first = await firstProcess.enqueue({
      tenantId: tenant, connectionId: connection, operation: 'post_bill',
      requestPayload: { qbxml: '<BillAddRq />' }, sourceKey: 'proposal:41',
    });
    const secondProcess = new DurableProviderJobs(getPool(), 60);
    const duplicate = await secondProcess.enqueue({
      tenantId: tenant, connectionId: connection, operation: 'post_bill',
      requestPayload: { qbxml: '<BillAddRq changed="ignored" />' }, sourceKey: 'proposal:41',
    });
    expect(duplicate.id).toBe(first.id);
    expect((await secondProcess.list(tenant)).map((job) => job.id)).toEqual([first.id]);
    expect(first.idempotencyKey).toBe(stableProviderJobKey({
      tenantId: tenant, connectionId: connection, operation: 'post_bill',
      sourceKey: 'proposal:41',
    }));
  });

  it('isolates leases by tenant and connection and allows only one active lease per connection', async () => {
    const tenantA = await createTenant('lease-a');
    const tenantB = await createTenant('lease-b');
    const connectionA = await desktopConnection(tenantA, 'company-a');
    const connectionB = await desktopConnection(tenantB, 'company-b');
    const jobs = new DurableProviderJobs(getPool(), 60);
    for (const sourceKey of ['one', 'two']) {
      await jobs.enqueue({
        tenantId: tenantA, connectionId: connectionA, operation: 'query',
        requestPayload: {}, sourceKey,
      });
    }
    await jobs.enqueue({
      tenantId: tenantB, connectionId: connectionB, operation: 'query',
      requestPayload: {}, sourceKey: 'foreign',
    });

    const [a1, a2, b1] = await Promise.all([
      jobs.leaseNext({ tenantId: tenantA, connectionId: connectionA, observedCompanyId: 'company-a' }),
      jobs.leaseNext({ tenantId: tenantA, connectionId: connectionA, observedCompanyId: 'company-a' }),
      jobs.leaseNext({ tenantId: tenantB, connectionId: connectionB, observedCompanyId: 'company-b' }),
    ]);
    expect([a1, a2].filter(Boolean)).toHaveLength(1);
    expect(b1?.tenantId).toBe(Number(tenantB));
    expect((await jobs.list(tenantA))).toHaveLength(2);
    expect((await jobs.list(tenantB))).toHaveLength(1);
  });

  it('recovers an expired pre-send lease but holds an expired sent/uncertain result', async () => {
    const tenant = await createTenant('expiry');
    const connection = await desktopConnection(tenant, 'company-a');
    const jobs = new DurableProviderJobs(getPool(), 1);
    await jobs.enqueue({
      tenantId: tenant, connectionId: connection, operation: 'query',
      requestPayload: {}, sourceKey: 'recoverable',
    });
    const leased = await jobs.leaseNext({
      tenantId: tenant, connectionId: connection, observedCompanyId: 'company-a',
    });
    await query(`UPDATE provider_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [leased!.id]);
    const recovered = await jobs.leaseNext({
      tenantId: tenant, connectionId: connection, observedCompanyId: 'company-a',
    });
    expect(recovered?.id).toBe(leased!.id);
    expect(recovered?.attempts).toBe(2);

    expect(await jobs.markSent(tenant, recovered!.id, recovered!.leaseToken!)).toBe(true);
    await query(`UPDATE provider_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [recovered!.id]);
    expect(await jobs.leaseNext({
      tenantId: tenant, connectionId: connection, observedCompanyId: 'company-a',
    })).toBeNull();
    const held = (await jobs.list(tenant))[0]!;
    expect(held.status).toBe('held');
    expect(held.errorCode).toBe('UNCERTAIN_OUTCOME');
    await expect(jobs.retry(tenant, held.id)).rejects.toBeInstanceOf(UnsafeProviderJobRetryError);
  });

  it('holds queued work when the observed QuickBooks company identity mismatches', async () => {
    const tenant = await createTenant('identity');
    const connection = await desktopConnection(tenant, 'expected-company');
    const jobs = new DurableProviderJobs(getPool(), 60);
    await jobs.enqueue({
      tenantId: tenant, connectionId: connection, operation: 'post_bill',
      requestPayload: {}, sourceKey: 'identity-check',
    });
    expect(await jobs.leaseNext({
      tenantId: tenant, connectionId: connection, observedCompanyId: 'wrong-company',
    })).toBeNull();
    const held = (await jobs.list(tenant))[0]!;
    expect(held.status).toBe('held');
    expect(held.errorCode).toBe('COMPANY_IDENTITY_MISMATCH');
    expect(held.errorDetail).toContain('wrong-company');
  });

  it('exposes tenant-scoped status and retry to owners only', async () => {
    const tenantA = await createTenant('api-a');
    const tenantB = await createTenant('api-b');
    const connectionA = await desktopConnection(tenantA, 'company-a');
    const connectionB = await desktopConnection(tenantB, 'company-b');
    const jobs = new DurableProviderJobs(getPool(), 60);
    const own = await jobs.enqueue({
      tenantId: tenantA, connectionId: connectionA, operation: 'query',
      requestPayload: {}, sourceKey: 'own',
    });
    await jobs.enqueue({
      tenantId: tenantB, connectionId: connectionB, operation: 'query',
      requestPayload: {}, sourceKey: 'foreign',
    });
    await query(
      `UPDATE provider_jobs SET status='failed',error_code='SAFE_FAILURE' WHERE tenant_id=$1 AND id=$2`,
      [tenantA, own.id],
    );
    const owner = await createSession(await createUser(tenantA, { role: 'owner_controller' }));
    const bookkeeper = await createSession(await createUser(tenantA, { role: 'bookkeeper' }));
    const request = (token: string) => new Request('http://localhost/api/provider-jobs', {
      headers: { authorization: `Bearer ${token}` },
    });

    const listed = await listJobs(request(owner.token));
    expect(listed.status).toBe(200);
    const body = await listed.json() as { data: { jobs: Array<{ id: number }> } };
    expect(body.data.jobs.map((job) => job.id)).toEqual([own.id]);
    expect((await listJobs(request(bookkeeper.token))).status).toBe(403);

    const retried = await retryJob(request(owner.token), {
      params: Promise.resolve({ id: String(own.id) }),
    });
    expect(retried.status).toBe(200);
    expect((await retried.json() as { data: { status: string } }).data.status).toBe('queued');
    expect((await retryJob(request(bookkeeper.token), {
      params: Promise.resolve({ id: String(own.id) }),
    })).status).toBe(403);
  });
});
