import { describe, it, expect, vi } from 'vitest';
import { probeOllama, probeLmStudio, type RuntimeInfo } from '../src/llm/detect.js';
import { resolveProvider, LlmNotConfiguredError } from '../src/llm/provider.js';
import { getOpenAiCompatibleExtractor, cliArgsFor } from '../src/extract/model.js';
import { renderPdfToPngs } from '../src/extract/pdf.js';
import type { Config } from '../src/config.js';

function cfg(over: Partial<Config> = {}): Config {
  return {
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', LLM_PROVIDER: 'auto',
    LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '',
    ...over,
  } as unknown as Config;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const UNAVAIL: RuntimeInfo = { available: false, models: [], label: 'x' };
const OLLAMA_UP: RuntimeInfo = { available: true, baseUrl: 'http://localhost:11434/v1', models: ['llama3.2-vision'], label: 'Ollama' };

describe('runtime detection', () => {
  it('probeOllama reports available + models + /v1 base', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ models: [{ name: 'llava' }, { name: 'qwen2.5' }] }));
    const info = await probeOllama('http://localhost:11434', f as unknown as typeof fetch);
    expect(info.available).toBe(true);
    expect(info.baseUrl).toBe('http://localhost:11434/v1');
    expect(info.models).toContain('llava');
  });

  it('probeLmStudio returns unavailable when the server is down', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const info = await probeLmStudio('http://localhost:1234', f as unknown as typeof fetch);
    expect(info.available).toBe(false);
  });
});

describe('provider resolution', () => {
  const noRuntimes = { probeOllamaImpl: async () => UNAVAIL, probeLmStudioImpl: async () => UNAVAIL, detectCliImpl: () => null };

  it('explicit custom endpoint -> openai kind', async () => {
    const p = await resolveProvider(cfg({ LLM_PROVIDER: 'custom', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm' }), noRuntimes);
    expect(p.kind).toBe('openai');
    expect(p.baseUrl).toBe('http://x/v1');
    expect(p.vision).toBe(true);
    expect(p.supportsPdfNative).toBe(false);
  });

  it('auto picks a configured LLM_BASE_URL before anything else', async () => {
    const p = await resolveProvider(cfg({ LLM_BASE_URL: 'http://openrouter/v1', LLM_API_KEY: 'k', LLM_MODEL: 'gpt' }), noRuntimes);
    expect(p.kind).toBe('openai');
    expect(p.apiKey).toBe('k');
  });

  it('auto detects a running Ollama when no endpoint/key is set', async () => {
    const p = await resolveProvider(cfg(), { ...noRuntimes, probeOllamaImpl: async () => OLLAMA_UP });
    expect(p.label).toBe('Ollama');
    expect(p.baseUrl).toBe('http://localhost:11434/v1');
    expect(p.model).toBe('llama3.2-vision');
  });

  it('auto falls back to an Anthropic key, native PDF', async () => {
    const p = await resolveProvider(cfg({ ANTHROPIC_API_KEY: 'sk-ant' }), noRuntimes);
    expect(p.kind).toBe('anthropic');
    expect(p.supportsPdfNative).toBe(true);
  });

  it('throws a helpful error when nothing is available', async () => {
    await expect(resolveProvider(cfg(), noRuntimes)).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});

describe('OpenAI-compatible extractor', () => {
  it('POSTs to /chat/completions and parses the JSON reply', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '```json\n{"vendor_name":"Acme","total":10}\n```' } }] }),
    );
    const ex = await getOpenAiCompatibleExtractor({ baseUrl: 'http://localhost:11434/v1', model: 'llava', fetchImpl: f as unknown as typeof fetch });
    const out = (await ex.extract({ bodyText: 'Invoice from Acme, total 10' })) as any;
    expect(out.vendor_name).toBe('Acme');
    const call = f.mock.calls[0]!;
    expect(String(call[0])).toContain('/chat/completions');
  });

  it('sends an image as a data-URL image_url part', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"doc_type":"invoice"}' } }] }));
    const ex = await getOpenAiCompatibleExtractor({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: f as unknown as typeof fetch });
    await ex.extract({ bytes: Buffer.from([1, 2, 3]), mime: 'image/png' });
    const body = JSON.parse((f.mock.calls[0]![1] as any).body);
    const parts = body.messages[0].content;
    expect(parts.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
  });
});

describe('CLI extractor uses the correct per-CLI headless flags (H1 regression)', () => {
  it('maps each CLI to its real headless entrypoint, not --print for all', () => {
    expect(cliArgsFor('claude')).toEqual(['-p']);
    expect(cliArgsFor('codex')).toEqual(['exec']); // NOT --print
    expect(cliArgsFor('gemini')).toEqual([]); // reads stdin; NOT --print
    // The prompt is never on argv (passed via stdin) — no flag value carries text.
    expect(cliArgsFor('codex')).not.toContain('--print');
  });
});

describe('PDF rendering (MuPDF, full PDF support for non-Anthropic vision)', () => {
  it('renders a PDF to at least one PNG page image', async () => {
    // Minimal one-page PDF.
    const b64 =
      'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXS9SZXNvdXJjZXM8PD4+Pj4KZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDQvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoyMTAKJSVFT0YK';
    const pngs = await renderPdfToPngs(Buffer.from(b64, 'base64'));
    expect(pngs.length).toBeGreaterThanOrEqual(1);
    // PNG magic number.
    expect(pngs[0]!.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});
