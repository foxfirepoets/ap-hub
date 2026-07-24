import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountingIntakeRepository,
  InvalidAccountingContractError,
  type TenantQuery,
} from '../src/accounting/index.js';

const now = new Date('2026-07-24T00:00:00Z');

function result<T extends Record<string, unknown>>(row: T) {
  return { rows: [row], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
}

describe('provider-neutral accounting intake contracts', () => {
  it('maps a valid tenant-scoped document row without numeric coercion of confidence', async () => {
    const run = vi.fn().mockResolvedValue(result({
      id: '11', tenant_id: '7', message_id: '8', attachment_id: null,
      kind: 'bank_statement', sha256: 'hash', status: 'review',
      classification_confidence: '0.9500', hold_reason: null,
      created_at: now, updated_at: now,
    })) as unknown as TenantQuery;
    const repo = new AccountingIntakeRepository(run);

    const document = await repo.createDocument({
      tenantId: 7, messageId: 8, kind: 'bank_statement', sha256: 'hash',
      status: 'review', classificationConfidence: '0.9500',
    });

    expect(document).toMatchObject({
      id: 11, tenantId: 7, messageId: 8, kind: 'bank_statement',
      classificationConfidence: '0.9500',
    });
    expect(vi.mocked(run).mock.calls[0]?.[0]).toBe(7);
    expect(vi.mocked(run).mock.calls[0]?.[1]).toContain('tenant_id');
  });

  it('rejects invalid lifecycle values before a query runs', async () => {
    const run = vi.fn() as unknown as TenantQuery;
    const repo = new AccountingIntakeRepository(run);

    await expect(repo.createDocument({
      tenantId: 1, messageId: 2, kind: 'invoice', sha256: 'hash',
      status: 'invented' as never,
    })).rejects.toBeInstanceOf(InvalidAccountingContractError);
    await expect(repo.createReplyDraft({
      tenantId: 1, messageId: 2, threadId: 'thread', toAddress: 'vendor@example.test',
      subject: 'Question', bodyText: 'Please clarify', createdBy: 3,
      status: 'sent_by_app' as never,
    })).rejects.toBeInstanceOf(InvalidAccountingContractError);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate key', '23505'],
    ['foreign tenant reference', '23503'],
  ])('preserves database %s failures for callers', async (_label, code) => {
    const failure = Object.assign(new Error('database rejected row'), { code });
    const run = vi.fn().mockRejectedValue(failure) as unknown as TenantQuery;
    const repo = new AccountingIntakeRepository(run);

    await expect(repo.enqueueProviderJob({
      tenantId: 9, connectionId: 10, operation: 'post_bill',
      requestPayload: {}, idempotencyKey: 'stable-key',
    })).rejects.toMatchObject({ code });
  });

  it('keeps core repositories free of provider writer imports', () => {
    const source = readFileSync(
      new URL('../src/accounting/repositories.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"].*(?:qbo|qbdesktop|gmail)/i);
    expect(source).not.toMatch(/\b(?:send|postBill|createDraft)\s*\(/);
  });
});
