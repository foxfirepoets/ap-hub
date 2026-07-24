import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://x',
  ENCRYPTION_KEY: '0'.repeat(64),
  ANTHROPIC_API_KEY: 'k',
  GMAIL_CLIENT_ID: 'g',
  GMAIL_CLIENT_SECRET: 's',
  GOOGLE_SSO_CLIENT_ID: 'sso-client',
  GOOGLE_SSO_CLIENT_SECRET: 'sso-secret',
  SESSION_COOKIE_SECRET: 'x'.repeat(32),
  SWARMSYNC_API_KEY: 'ssk_live_x',
};

describe('config', () => {
  it('defaults QBO_ENV to sandbox and loads SwarmSync + gatekeeper vars', () => {
    const cfg = loadConfig({ ...baseEnv } as any);
    expect(cfg.QBO_ENV).toBe('sandbox');
    expect(cfg.SWARMSYNC_API_BASE).toBe('https://api.swarmsync.ai');
    expect(cfg.SWARMSYNC_WEB_BASE).toBe('https://swarmsync.ai');
    expect(cfg.GATEKEEPER_ENABLED).toBe(false);
  });

  it('HARD-REFUSES QBO_ENV=production', () => {
    expect(() => loadConfig({ ...baseEnv, QBO_ENV: 'production' } as any)).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, QBO_ENV: 'production' } as any)).toThrow(/refused/i);
  });

  it('fails fast on a missing required var with the var name', () => {
    const { DATABASE_URL: _omit, ...rest } = baseEnv;
    expect(() => loadConfig({ ...rest } as any)).toThrow(/DATABASE_URL/);
  });

  it('requires full gatekeeper config when enabled (white-label)', () => {
    expect(() =>
      loadConfig({ ...baseEnv, GATEKEEPER_ENABLED: 'true' } as any),
    ).toThrow(/QBO_FORWARDING_ADDRESS/);
    const cfg = loadConfig({
      ...baseEnv,
      GATEKEEPER_ENABLED: 'true',
      QBO_FORWARDING_ADDRESS: 'co@qbodocs.com',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_CHAT_ID: '999',
    } as any);
    expect(cfg.GATEKEEPER_ENABLED).toBe(true);
    expect(cfg.QBO_FORWARDING_ADDRESS).toBe('co@qbodocs.com');
  });

  it('refuses an empty or short session signing secret', () => {
    expect(() => loadConfig({ ...baseEnv, SESSION_COOKIE_SECRET: '' } as any)).toThrow(
      /SESSION_COOKIE_SECRET/,
    );
    expect(() => loadConfig({ ...baseEnv, SESSION_COOKIE_SECRET: 'short' } as any)).toThrow(
      /SESSION_COOKIE_SECRET/,
    );
  });

  it('refuses proofless autopost and QuickBooks Desktop write mode', () => {
    expect(() => loadConfig({ ...baseEnv, SWARMSYNC_OFF_MODE: 'autopost' } as any)).toThrow(
      /SWARMSYNC_OFF_MODE/,
    );
    expect(() => loadConfig({ ...baseEnv, QB_DESKTOP_MODE: 'write' } as any)).toThrow(
      /QB_DESKTOP_MODE/,
    );
  });
});
