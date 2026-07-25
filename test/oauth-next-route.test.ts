import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runGmailOAuthCallback,
  runQboOAuthCallback,
} from '../src/services/action/oauth-callback.js';
import { closeAll, resetTables } from './helpers.js';

describe('Next OAuth callback adapters', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('fails a Gmail callback closed when state is absent', async () => {
    const response = await runGmailOAuthCallback(
      new Request('https://hub.example.test/oauth/gmail/callback?code=forged'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_state' });
  });

  it('fails a QBO callback closed when state is absent', async () => {
    const response = await runQboOAuthCallback(
      new Request('https://hub.example.test/oauth/qbo/callback?code=forged&realmId=forged'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_state' });
  });
});
