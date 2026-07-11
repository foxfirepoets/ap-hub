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

describe('no_prod_write (CHUNK_7 environment isolation)', () => {
  it('refuses to construct a writer unless QBO_ENV=sandbox', () => {
    expect(() =>
      createQboWriteClient({ qboEnv: 'production', accessToken: 't', realmId: 'r', minorVersion: '73' }),
    ).toThrow(ProductionWriteRefused);
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
