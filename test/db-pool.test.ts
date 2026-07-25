import { describe, expect, it } from 'vitest';
import { normalizePostgresConnectionString } from '../src/db/pool.js';

describe('normalizePostgresConnectionString', () => {
  it.each(['require', 'prefer', 'verify-ca'])(
    'upgrades legacy sslmode=%s to explicit certificate verification',
    (sslmode) => {
      const normalized = normalizePostgresConnectionString(
        `postgres://user:pass@example.com/db?sslmode=${sslmode}&channel_binding=require`,
      );
      const url = new URL(normalized);
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
      expect(url.searchParams.get('channel_binding')).toBe('require');
    },
  );

  it('preserves verify-full and non-URL connection strings', () => {
    const verified = 'postgres://user:pass@example.com/db?sslmode=verify-full';
    const keyword = 'host=localhost dbname=aphub';
    expect(normalizePostgresConnectionString(verified)).toBe(verified);
    expect(normalizePostgresConnectionString(keyword)).toBe(keyword);
  });
});
