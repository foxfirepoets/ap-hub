import { describe, expect, it, vi } from 'vitest';
import { collectOperationalHealth } from '../src/http.js';

describe('operational health', () => {
  it('reports only aggregate provider, statement, and draft failure signals', async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          queued: 4,
          oldest_queued_seconds: 1810,
          expired_leases: 1,
          result_unknown: 2,
          failed: 3,
          held: 5,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ held: 7, unbalanced: 8 }] })
      .mockResolvedValueOnce({ rows: [{ failed: 9, result_unknown: 6 }] });

    const result = await collectOperationalHealth(runQuery);

    expect(result).toEqual({
      providerJobs: {
        queued: 4,
        oldestQueuedSeconds: 1810,
        expiredLeases: 1,
        resultUnknown: 2,
        failed: 3,
        held: 5,
      },
      statements: { held: 7, unbalanced: 8 },
      drafts: { failed: 9, resultUnknown: 6 },
    });
    expect(JSON.stringify(result)).not.toMatch(/payload|address|password|token|body/i);
  });

  it('handles an empty database without manufacturing queue age', async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          queued: '0',
          oldest_queued_seconds: null,
          expired_leases: '0',
          result_unknown: '0',
          failed: '0',
          held: '0',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ held: '0', unbalanced: '0' }] })
      .mockResolvedValueOnce({ rows: [{ failed: '0', result_unknown: '0' }] });

    const result = await collectOperationalHealth(runQuery);
    expect(result.providerJobs.oldestQueuedSeconds).toBeNull();
    expect(result.providerJobs.queued).toBe(0);
  });
});
