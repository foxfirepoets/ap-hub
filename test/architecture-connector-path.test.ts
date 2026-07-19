import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createQboConnector } from '../src/connectors/qbo.js';
import type { QboWriteClient } from '../src/qbo/write.js';
import type { QboReadClient } from '../src/qbo/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(path.join(here, '..', rel), 'utf8');

/**
 * F4-WIRE architectural guarantee: the LIVE posting path (postSandboxHandler) must
 * reach QBO through the provider-neutral connector wrapper (src/connectors/qbo.ts),
 * not only the raw src/qbo/write.ts client — and the connector itself must never
 * grow a second, parallel QBO write implementation. Static/source checks here are
 * grep-verifiable, same style as the send_lockdown/no_qbo_write guarantees.
 */
describe('architecture: production posting path routes through the connector', () => {
  it('postSandboxHandler references the connector module (src/connectors/qbo.js)', () => {
    const postingSrc = src('src/pipeline/posting.ts');
    const handlerStart = postingSrc.indexOf('export async function postSandboxHandler');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBody = postingSrc.slice(handlerStart);
    expect(handlerBody).toContain('../connectors/qbo.js');
    expect(handlerBody).toContain('createQboConnector');
    // The company-identity check is wired through the connector's own method, not a
    // second hand-rolled comparison against getCompanyInfo().
    expect(handlerBody).toContain('connector.verifyCompanyIdentity');
  });

  it('postOnce holds on company mismatch BEFORE calling writer.createEntity (F5 guarantee — see test/posting.test.ts:company_mismatch_holds for the behavioral case this wiring depends on)', () => {
    // This file only asserts the import-graph/wiring; the behavioral coverage
    // (mismatch → held, createEntity never called) already exists in
    // test/posting.test.ts and is intentionally not duplicated here.
    const postingSrc = src('src/pipeline/posting.ts');
    const verifyGuardIdx = postingSrc.indexOf("if (deps.verifyCompany)");
    const createCallIdx = postingSrc.indexOf('deps.writer.createEntity(');
    expect(verifyGuardIdx).toBeGreaterThan(-1);
    expect(createCallIdx).toBeGreaterThan(-1);
    expect(verifyGuardIdx).toBeLessThan(createCallIdx);
  });

  it('src/connectors/qbo.ts create() delegates to the wrapped write client — no duplicate QBO write implementation', () => {
    const connectorSrc = src('src/connectors/qbo.ts');
    // Delegation-only: no direct HTTP call anywhere in the connector file.
    expect(connectorSrc).not.toContain('fetch(');
    const createStart = connectorSrc.indexOf('async create(');
    expect(createStart).toBeGreaterThan(-1);
    const createEnd = connectorSrc.indexOf('\n  },', createStart);
    const createBody = connectorSrc.slice(createStart, createEnd === -1 ? undefined : createEnd);
    expect(createBody).toContain("writeClient.createEntity('Bill'");
  });

  it('behaviorally confirms createQboConnector.create() calls writeClient.createEntity(\'Bill\', ...) exactly once', async () => {
    const write: QboWriteClient = {
      realm: 'sandbox-realm',
      createEntity: vi.fn().mockResolvedValue({ id: 'b1', syncToken: '0', entity: { Id: 'b1' } }),
      readEntity: vi.fn(),
      queryExisting: vi.fn(),
      attach: vi.fn(),
    };
    const read: QboReadClient = {
      getCompanyInfo: vi.fn().mockResolvedValue({ CompanyName: 'Sandbox Co' }),
      queryEntity: vi.fn().mockResolvedValue([]),
    };
    const connector = createQboConnector({ writeClient: write, readClient: read });
    await connector.create(
      'bill',
      { kind: 'bill', canonical: { vendorId: 'V1', docNumber: 'INV-1', txnDate: '2026-07-01', total: '100', lines: [] } as any },
      'idem-1',
    );
    expect(write.createEntity).toHaveBeenCalledTimes(1);
    expect(write.createEntity).toHaveBeenCalledWith('Bill', expect.any(Object), 'idem-1');
  });
});
