import { spawnSyncPortable } from '../host/process.js';

/**
 * LLM backend detection. ap-hub works with WHATEVER LLM the operator has:
 *   - a local runtime exposing an OpenAI-compatible server (Ollama, LM Studio,
 *     Jan, LocalAI, vLLM, ...) — free, no key;
 *   - any OpenAI-compatible HTTP API (OpenAI, OpenRouter, Groq, Together, Azure);
 *   - a cloud key (Anthropic native, or OpenAI);
 *   - a headless CLI (Claude Code / Codex / Gemini) — text-only here (ap-hub
 *     extraction is vision; a CLI can't take an image, so it is offered only as
 *     an explicit text fallback, never auto-selected for scanned documents).
 *
 * Desktop chat GUIs (Claude Desktop, ChatGPT Desktop) expose NO programmatic
 * endpoint and can never be a backend — the wizard says so and points the user
 * at a key or a local runtime instead.
 *
 * Every probe is best-effort with a short timeout and an injectable fetch so
 * detection is unit-tested without any server present.
 */

const PROBE_TIMEOUT_MS = 1500;

export interface RuntimeInfo {
  available: boolean;
  /** OpenAI-compatible base URL (…/v1) when available. */
  baseUrl?: string;
  models: string[];
  label: string;
}

async function tryFetch(url: string, fetchImpl: typeof fetch, headers?: Record<string, string>): Promise<Response | null> {
  try {
    return await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/** Ollama: GET /api/tags lists local models; its OpenAI-compatible base is /v1. */
export async function probeOllama(
  host = process.env.OLLAMA_HOST || 'http://localhost:11434',
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeInfo> {
  const res = await tryFetch(`${host.replace(/\/$/, '')}/api/tags`, fetchImpl);
  if (!res || !res.ok) return { available: false, models: [], label: 'Ollama' };
  try {
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    return { available: true, baseUrl: `${host.replace(/\/$/, '')}/v1`, models, label: 'Ollama' };
  } catch {
    return { available: false, models: [], label: 'Ollama' };
  }
}

/** LM Studio serves an OpenAI-compatible API directly at /v1. */
export async function probeLmStudio(
  host = process.env.LMSTUDIO_HOST || 'http://localhost:1234',
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeInfo> {
  const base = `${host.replace(/\/$/, '')}/v1`;
  const res = await tryFetch(`${base}/models`, fetchImpl);
  if (!res || !res.ok) return { available: false, models: [], label: 'LM Studio' };
  try {
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    return { available: true, baseUrl: base, models, label: 'LM Studio' };
  } catch {
    return { available: false, models: [], label: 'LM Studio' };
  }
}

/** Generic OpenAI-compatible server probe (GET {base}/models). */
export async function probeOpenAiCompatible(
  baseUrl: string,
  apiKey = '',
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeInfo> {
  const base = baseUrl.replace(/\/$/, '');
  const res = await tryFetch(`${base}/models`, fetchImpl, apiKey ? { authorization: `Bearer ${apiKey}` } : undefined);
  if (!res || !res.ok) return { available: false, models: [], label: 'OpenAI-compatible' };
  try {
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    return { available: true, baseUrl: base, models, label: 'OpenAI-compatible' };
  } catch {
    return { available: true, baseUrl: base, models: [], label: 'OpenAI-compatible' };
  }
}

export type CliName = 'claude' | 'codex' | 'gemini';

/** Detect an installed, working LLM CLI by running `<bin> --version`. */
export function detectCli(): { name: CliName; bin: string } | null {
  for (const bin of ['claude', 'codex', 'gemini'] as CliName[]) {
    try {
      const r = spawnSyncPortable(bin, ['--version'], { timeout: 5000, stdio: 'ignore' });
      if (r.status === 0) return { name: bin, bin };
    } catch {
      /* not present */
    }
  }
  return null;
}
