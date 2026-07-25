import { describe, it, expect, vi } from 'vitest';
import { createQboConnector } from '../src/connectors/qbo.js';
import { createXeroConnector, createSageIntacctConnector, createQbdConnector } from '../src/connectors/stubs.js';
import { NotImplementedInPhase, type AccountingConnector } from '../src/connectors/types.js';
import type { CanonicalBill, CanonicalRecord, Unsupported } from '../src/canonical/model.js';
import type { QboWriteClient } from '../src/qbo/write.js';
import type { QboReadClient } from '../src/qbo/client.js';

function mockWrite(overrides: Partial<QboWriteClient> = {}): QboWriteClient {
  return {
    realm: 'sandbox-realm',
    createEntity: vi.fn().mockResolvedValue({ id: 'b1', syncToken: '0', entity: { Id: 'b1', SyncToken: '0' } }),
    readEntity: vi.fn().mockResolvedValue({ Id: 'b1', SyncToken: '3', TotalAmt: 100, DocNumber: 'INV-1' }),
    queryExisting: vi.fn().mockResolvedValue([]),
    attach: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as QboWriteClient;
}

function mockRead(overrides: Partial<QboReadClient> = {}): QboReadClient {
  return {
    getCompanyInfo: vi.fn().mockResolvedValue({ CompanyName: 'Sandbox Company_US_1' }),
    queryEntity: vi.fn(async (entity: string) => {
      if (entity === 'Vendor') return [{ Id: 'V1', DisplayName: 'Acme' }];
      if (entity === 'Account') return [{ Id: '60', Name: 'Office Expense', AccountType: 'Expense' }];
      return [];
    }),
    ...overrides,
  } as QboReadClient;
}

const sampleBill: CanonicalBill = {
  vendorId: 'V1',
  vendorName: 'Acme',
  docNumber: 'INV-1',
  txnDate: '2026-07-01',
  total: '100',
  lines: [{ description: 'work', amount: '100', accountId: '60' }],
};

/**
 * Reusable connector contract suite. Every AccountingConnector implementation that
 * claims support must pass this against a live-or-mocked backend. QBO passes it here
 * with mocked HTTP clients; live sandbox coverage runs under `test:int`.
 */
export function runConnectorContract(name: string, makeConnector: () => AccountingConnector, expectedCompany: string): void {
  describe(`AccountingConnector contract — ${name}`, () => {
    it('declares a capability matrix with vendor+account read and bill write', () => {
      const caps = makeConnector().capabilities();
      expect(caps.read).toEqual(expect.arrayContaining(['vendor', 'account']));
      expect(caps.write).toContain('bill');
    });

    it('reads vendors and accounts as canonical records', async () => {
      const c = makeConnector();
      const vendors = await c.read('vendor');
      const accounts = await c.read('account');
      expect(vendors.length).toBeGreaterThan(0);
      expect((vendors[0]!.canonical as { name: string }).name).toBeTruthy();
      expect(accounts.length).toBeGreaterThan(0);
    });

    it('never silently no-ops a declared-but-unimplemented read: undeclared entities either return real records or throw/refuse — never []', async () => {
      const c = makeConnector();
      const caps = c.capabilities();
      for (const entity of ['bill', 'bill_line', 'attachment'] as const) {
        if (caps.read.includes(entity)) continue; // declared support must be exercised elsewhere
        await expect(c.read(entity)).rejects.toBeTruthy();
      }
    });

    it('verifyCompanyIdentity matches the expected company', async () => {
      const c = makeConnector();
      expect(await c.verifyCompanyIdentity({ name: expectedCompany })).toBe('match');
      expect(await c.verifyCompanyIdentity({ name: 'Wrong Co' })).toBe('mismatch');
    });

    it('create then readBack confirms externalId + revision', async () => {
      const c = makeConnector();
      const rec: CanonicalRecord = { kind: 'bill', canonical: sampleBill };
      const res = await c.create('bill', rec, 'idem-key-1');
      expect(res.external.id).toBeTruthy();
      const back = await c.readBack('bill', res.external.id);
      expect(back.external?.id).toBe(res.external.id);
      expect(back.external?.revision).toBeTruthy();
    });
  });
}

// --- QBO reference adapter must pass the contract (delegation-only wrap of src/qbo) ---
runConnectorContract('qbo', () => createQboConnector({ writeClient: mockWrite(), readClient: mockRead() }), 'Sandbox Company_US_1');

describe('QBO connector — capability gaps are surfaced, never silently dropped', () => {
  it('an unrepresentable dimension is returned as Unsupported and audited', async () => {
    const audited: Unsupported[] = [];
    const c = createQboConnector({ writeClient: mockWrite(), readClient: mockRead(), onUnsupported: (u) => audited.push(u) });
    const bill: CanonicalBill = { ...sampleBill, dimensions: [{ kind: 'project', id: 'P1' }] };
    const res = await c.create('bill', { kind: 'bill', canonical: bill }, 'idem-key-2');
    expect(res.capabilityGaps.some((g) => g.field === 'dimensions.project')).toBe(true);
    expect(audited.some((g) => g.field === 'dimensions.project')).toBe(true);
  });

  it('delegates the create to the wrapped write client (no reimplementation)', async () => {
    const w = mockWrite();
    const c = createQboConnector({ writeClient: w, readClient: mockRead() });
    await c.create('bill', { kind: 'bill', canonical: sampleBill }, 'idem-key-3');
    expect(w.createEntity).toHaveBeenCalledTimes(1);
    expect(w.createEntity).toHaveBeenCalledWith('Bill', expect.any(Object), 'idem-key-3');
  });

  it('holds ambiguous duplicate candidates and requires exact vendor and amount evidence', async () => {
    const queryExisting = vi.fn().mockResolvedValue([
      { Id: '1', VendorRef: { value: 'V1' }, TotalAmt: 100, SyncToken: '0' },
      { Id: '2', VendorRef: { value: 'V1' }, TotalAmt: 100, SyncToken: '0' },
    ]);
    const c = createQboConnector({
      writeClient: mockWrite({ queryExisting }),
      readClient: mockRead(),
    });
    const txn = {
      txnType: 'Bill', vendorRef: { value: 'V1' }, DocNumber: 'INV-1',
      TxnDate: '2026-07-01', TotalAmt: 100,
    };
    await expect(c.detectExisting(txn, 'key')).rejects.toThrow('QBO_AMBIGUOUS_DUPLICATE_MATCH');
    expect(queryExisting).toHaveBeenCalledWith(
      'Bill', expect.stringContaining("VendorRef = 'V1'"),
    );
  });

  it('treats a missing expected DocNumber in provider readback as a mismatch', async () => {
    const c = createQboConnector({
      writeClient: mockWrite({
        readEntity: vi.fn().mockResolvedValue({ Id: '1', TotalAmt: 100, SyncToken: '0' }),
      }),
      readClient: mockRead(),
    });
    await expect(c.readBackVerify({
      txnType: 'Bill', DocNumber: 'INV-1', TotalAmt: 100,
    }, '1')).resolves.toMatchObject({ verify: 'mismatch', reason: 'docnumber' });
  });
});

describe('provider stubs are capability-declaring but throw NotImplementedInPhase', () => {
  for (const [name, make] of [
    ['xero', createXeroConnector],
    ['sage_intacct', createSageIntacctConnector],
    ['qbd', createQbdConnector],
  ] as const) {
    it(`${name}: declares capabilities but refuses read/create`, async () => {
      const c = make();
      expect(c.capabilities().write).toContain('bill');
      await expect(c.read('vendor')).rejects.toBeInstanceOf(NotImplementedInPhase);
      await expect(c.create('bill', { kind: 'bill', canonical: sampleBill }, 'k')).rejects.toBeInstanceOf(NotImplementedInPhase);
    });
  }
});
