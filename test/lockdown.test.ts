import { describe, it, expect, vi } from 'vitest';
import { createLockedForwarder, ForwardRecipientError } from '../src/gatekeeper/forwarder.js';
import { createQboWriteClient, ProductionWriteRefused } from '../src/qbo/write.js';
import { createQboReadClient } from '../src/qbo/client.js';
import type { GmailClient } from '../src/gmail/client.js';

function mockGmail(sentTo: string): GmailClient {
  return {
    listHistory: vi.fn(),
    getMessage: vi.fn(),
    sendForward: vi.fn().mockResolvedValue({ sendId: 's1', to: sentTo }),
    findSentBySubjectTag: vi.fn(),
  } as any;
}

describe('send_lockdown (Phase 0.5 HARD REQUIREMENT)', () => {
  it('forwards only to the configured address (no recipient parameter exists)', async () => {
    const fwd = createLockedForwarder('co@qbodocs.com', mockGmail('co@qbodocs.com'));
    expect(fwd.recipient).toBe('co@qbodocs.com');
    // forward takes exactly one arg: the message id — never a recipient.
    expect(fwd.forward.length).toBe(1);
    const out = await fwd.forward('msg-1');
    expect(out.to).toBe('co@qbodocs.com');
  });

  it('throws if the underlying send addressed anyone else', async () => {
    const fwd = createLockedForwarder('co@qbodocs.com', mockGmail('attacker@evil.com'));
    await expect(fwd.forward('msg-1')).rejects.toBeInstanceOf(ForwardRecipientError);
  });

  it('refuses to build with an invalid forwarding address', () => {
    expect(() => createLockedForwarder('not-an-email', mockGmail('x'))).toThrow(ForwardRecipientError);
  });
});

describe('production_write_gate environment isolation', () => {
  it('refuses production unless its explicit write gate is enabled', () => {
    expect(() =>
      createQboWriteClient({ qboEnv: 'production', accessToken: 't', realmId: 'r', minorVersion: '73' }),
    ).toThrow(ProductionWriteRefused);
  });
  it('constructs production only with the explicit gate and selects the production API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ Bill: { Id: '1', SyncToken: '0' } }),
    });
    const w = createQboWriteClient({
      qboEnv: 'production', productionWriteEnabled: true,
      accessToken: 't', realmId: 'production-realm', minorVersion: '73',
      fetchImpl: fetchImpl as any,
    });
    await w.createEntity('Bill', {}, 'request-1');
    expect(fetchImpl.mock.calls[0]![0]).toContain('https://quickbooks.api.intuit.com/');
  });
  it('constructs for sandbox', () => {
    const w = createQboWriteClient({ qboEnv: 'sandbox', accessToken: 't', realmId: 'r', minorVersion: '73' });
    expect(w.realm).toBe('r');
  });
});

describe('no_qbo_write (CHUNK_2 read client has no write method)', () => {
  it('exposes only read methods', () => {
    const c = createQboReadClient({ accessToken: 't', realmId: 'r', minorVersion: '73' });
    expect(Object.keys(c).sort()).toEqual(['getCompanyInfo', 'queryEntity']);
    expect((c as any).createEntity).toBeUndefined();
    expect((c as any).update).toBeUndefined();
    expect((c as any).delete).toBeUndefined();
  });
});
