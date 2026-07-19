import { vi } from 'vitest';
import type { AccountingConnector } from '../src/connectors/types.js';

/**
 * Mock AccountingConnector for the posting-path guarantee tests (F4 migration). Defaults
 * mirror the old QboWriteClient mock 1:1 so every migrated assertion stays equal-or-stricter:
 *   postBill        <- createEntity   (one write; returns externalId/revision)
 *   detectExisting  <- queryExisting  (Layer-2 dedup; null = absent, throw = fail-closed)
 *   readBackVerify  <- readEntity+verifyMatches (authoritative read-back verdict)
 *   attachDocument  <- attach
 *   companyId       <- realm
 */
export function mockConnector(overrides: Partial<AccountingConnector> = {}): AccountingConnector {
  return {
    provider: 'qbo',
    connectionClass: 'cloud',
    companyId: 'sandbox-realm',
    capabilities: vi.fn(),
    verifyCompanyIdentity: vi.fn().mockResolvedValue('match'),
    read: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    readBack: vi.fn(),
    attach: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    detectExisting: vi.fn().mockResolvedValue(null),
    postBill: vi.fn().mockResolvedValue({ externalId: 'q1', revision: '0', raw: { Id: 'q1' } }),
    attachDocument: vi.fn().mockResolvedValue(undefined),
    readBackVerify: vi.fn().mockResolvedValue({ verify: 'match', revision: '0', raw: { TotalAmt: 100, DocNumber: 'INV-1' } }),
    ...overrides,
  } as AccountingConnector;
}
