import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeConnectState, createConnectState } from '../src/auth/connect-state.js';
import { createSession, revokeSession } from '../src/auth/session.js';
import { closeAll, createTenant, createUser, resetTables } from './helpers.js';

async function actor() {
  const tenantId = await createTenant();
  const userId = await createUser(tenantId);
  const session = await createSession(userId);
  return { tenantId: Number(tenantId), userId: Number(userId), sessionId: Number(session.id) };
}

describe('persistent OAuth connect state', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('consumes once for the bound provider', async () => {
    const a = await actor();
    const token = await createConnectState(a, 'gmail');
    await expect(consumeConnectState(token, 'gmail', a.sessionId)).resolves.toMatchObject(a);
    await expect(consumeConnectState(token, 'gmail', a.sessionId)).resolves.toBeNull();
  });

  it('rejects cross-provider use without consuming the valid provider state', async () => {
    const a = await actor();
    const token = await createConnectState(a, 'gmail');
    await expect(consumeConnectState(token, 'qbo', a.sessionId)).resolves.toBeNull();
    await expect(consumeConnectState(token, 'gmail', a.sessionId)).resolves.toMatchObject(a);
  });

  it('rejects expired state and a revoked initiating session', async () => {
    const a = await actor();
    const expired = await createConnectState(a, 'gmail', () => Date.now() - 6 * 60 * 1000);
    await expect(consumeConnectState(expired, 'gmail', a.sessionId)).resolves.toBeNull();

    const token = await createConnectState(a, 'gmail');
    await revokeSession(a.sessionId);
    await expect(consumeConnectState(token, 'gmail', a.sessionId)).resolves.toBeNull();
  });

  it('atomically permits exactly one concurrent consumer', async () => {
    const a = await actor();
    const token = await createConnectState(a, 'qbo');
    const results = await Promise.all([
      consumeConnectState(token, 'qbo', a.sessionId),
      consumeConnectState(token, 'qbo', a.sessionId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((v) => v === null)).toHaveLength(1);
  });

  it('rejects a different valid session without consuming the initiating state', async () => {
    const initiating = await actor();
    const otherSession = await createSession(initiating.userId);
    const token = await createConnectState(initiating, 'gmail');
    await expect(consumeConnectState(token, 'gmail', Number(otherSession.id))).resolves.toBeNull();
    await expect(consumeConnectState(token, 'gmail', initiating.sessionId)).resolves.toMatchObject(initiating);
  });
});
