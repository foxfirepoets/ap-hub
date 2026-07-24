import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { resetTables, createTenant, insertMessage, closeAll, countRows } from './helpers.js';

/**
 * HKO-truth-audit finding (RIO/behavioral, re-verified against the merged
 * src/llm/provider.ts backend): getExtractor() can throw LlmNotConfiguredError (no
 * local runtime, no OpenAI-compatible endpoint, no key, no explicitly-chosen CLI) —
 * a failure mode this job could not reach before ANTHROPIC_API_KEY was a hard
 * boot-time requirement. Proves it surfaces as a typed `exceptions` row (CLAUDE.md:
 * "every failure is a typed exceptions row — no silent failures"), never a bare job
 * throw invisible outside pg-boss retry logs.
 */
vi.mock('../src/extract/model.js', async () => {
  const actual = await vi.importActual<typeof import('../src/extract/model.js')>('../src/extract/model.js');
  const { LlmNotConfiguredError } = await import('../src/llm/provider.js');
  return {
    ...actual,
    getExtractor: vi.fn().mockRejectedValue(new LlmNotConfiguredError('no backend available (test)')),
  };
});

describe('extractHandler — LLM backend misconfiguration is a visible exception, not a silent throw', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('raises extractor_not_configured instead of throwing past the job handler', async () => {
    const { extractHandler } = await import('../src/pipeline/extract.js');
    const t = await createTenant();
    const m = await insertMessage(t);

    await expect(
      extractHandler({ data: { tenantId: t, messageId: m, attachmentId: null } }),
    ).resolves.toBeUndefined();

    expect(await countRows('exceptions', "reason_code='extractor_not_configured'")).toBe(1);
    expect(await countRows('extractions')).toBe(0);
  });
});
