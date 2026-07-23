import type { Config } from '../config.js';
import { probeOllama, probeLmStudio, detectCli, type RuntimeInfo } from './detect.js';

/**
 * Resolve WHICH LLM backend to use from config + machine detection, without any
 * tenant-specific code. Priority (all overridable by LLM_PROVIDER):
 *   1. explicit LLM_PROVIDER (anthropic | openai | ollama | lmstudio | custom | claude|codex|gemini)
 *   2. a configured OpenAI-compatible endpoint (LLM_BASE_URL)
 *   3. a running local runtime (Ollama, then LM Studio) — free, no key
 *   4. an Anthropic key (native vision + PDF)
 *   5. an OpenAI key
 * A vision document (image/PDF) needs a vision-capable HTTP provider; a CLI is
 * accepted only when explicitly chosen and is treated as text-only.
 */

export type ProviderKind = 'anthropic' | 'openai' | 'cli';

export interface ResolvedProvider {
  kind: ProviderKind;
  model: string;
  /** OpenAI-compatible base URL (…/v1) for kind 'openai'. */
  baseUrl?: string;
  apiKey?: string;
  cliBin?: string;
  /** Anthropic accepts PDFs directly; others need pages rendered to images. */
  supportsPdfNative: boolean;
  /** Whether this backend can see images at all (CLIs cannot). */
  vision: boolean;
  label: string;
}

export class LlmNotConfiguredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LlmNotConfiguredError';
  }
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

function anthropic(cfg: Config): ResolvedProvider {
  if (!cfg.ANTHROPIC_API_KEY) {
    throw new LlmNotConfiguredError('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty.');
  }
  return {
    kind: 'anthropic',
    model: cfg.LLM_MODEL || DEFAULT_ANTHROPIC_MODEL,
    apiKey: cfg.ANTHROPIC_API_KEY,
    supportsPdfNative: true,
    vision: true,
    label: 'Anthropic API',
  };
}

function openai(baseUrl: string, apiKey: string, model: string, label: string): ResolvedProvider {
  return { kind: 'openai', model, baseUrl: baseUrl.replace(/\/$/, ''), apiKey, supportsPdfNative: false, vision: true, label };
}

export interface ResolveDeps {
  fetchImpl?: typeof fetch;
  probeOllamaImpl?: typeof probeOllama;
  probeLmStudioImpl?: typeof probeLmStudio;
  detectCliImpl?: typeof detectCli;
}

export async function resolveProvider(cfg: Config, deps: ResolveDeps = {}): Promise<ResolvedProvider> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probeOll = deps.probeOllamaImpl ?? probeOllama;
  const probeLm = deps.probeLmStudioImpl ?? probeLmStudio;
  const detCli = deps.detectCliImpl ?? detectCli;
  const choice = (cfg.LLM_PROVIDER || 'auto').trim().toLowerCase();

  const firstModel = (info: RuntimeInfo, fallback: string): string =>
    cfg.LLM_MODEL || info.models[0] || fallback;

  // 1. Explicit provider.
  switch (choice) {
    case 'anthropic':
      return anthropic(cfg);
    case 'openai':
      if (!cfg.OPENAI_API_KEY && !cfg.LLM_API_KEY) throw new LlmNotConfiguredError('LLM_PROVIDER=openai but no OPENAI_API_KEY/LLM_API_KEY.');
      return openai('https://api.openai.com/v1', cfg.OPENAI_API_KEY || cfg.LLM_API_KEY, cfg.LLM_MODEL || DEFAULT_OPENAI_MODEL, 'OpenAI');
    case 'ollama': {
      const info = await probeOll(undefined, fetchImpl);
      const base = info.baseUrl ?? 'http://localhost:11434/v1';
      return openai(base, '', firstModel(info, 'llama3.2-vision'), 'Ollama');
    }
    case 'lmstudio': {
      const info = await probeLm(undefined, fetchImpl);
      const base = info.baseUrl ?? 'http://localhost:1234/v1';
      return openai(base, '', firstModel(info, 'local-model'), 'LM Studio');
    }
    case 'custom':
    case 'openai_compatible':
      if (!cfg.LLM_BASE_URL) throw new LlmNotConfiguredError('LLM_PROVIDER=custom but LLM_BASE_URL is empty.');
      return openai(cfg.LLM_BASE_URL, cfg.LLM_API_KEY, cfg.LLM_MODEL || 'gpt-4o', 'OpenAI-compatible');
    case 'claude':
    case 'codex':
    case 'gemini': {
      const cli = detCli();
      if (!cli || cli.name !== choice) throw new LlmNotConfiguredError(`LLM_PROVIDER=${choice} but that CLI is not installed/authenticated.`);
      return { kind: 'cli', model: choice, cliBin: cli.bin, supportsPdfNative: false, vision: false, label: `${choice} CLI (text-only)` };
    }
    case 'auto':
    case '':
      break;
    default:
      throw new LlmNotConfiguredError(`Unknown LLM_PROVIDER '${choice}'.`);
  }

  // 2. Configured OpenAI-compatible endpoint.
  if (cfg.LLM_BASE_URL) {
    return openai(cfg.LLM_BASE_URL, cfg.LLM_API_KEY, cfg.LLM_MODEL || 'gpt-4o', 'OpenAI-compatible');
  }
  // 3. Local runtimes (free, no key) — vision-capable models common on both.
  const oll = await probeOll(undefined, fetchImpl);
  if (oll.available) return openai(oll.baseUrl!, '', firstModel(oll, 'llama3.2-vision'), 'Ollama');
  const lm = await probeLm(undefined, fetchImpl);
  if (lm.available) return openai(lm.baseUrl!, '', firstModel(lm, 'local-model'), 'LM Studio');
  // 4. Cloud keys.
  if (cfg.ANTHROPIC_API_KEY) return anthropic(cfg);
  if (cfg.OPENAI_API_KEY) return openai('https://api.openai.com/v1', cfg.OPENAI_API_KEY, cfg.LLM_MODEL || DEFAULT_OPENAI_MODEL, 'OpenAI');

  throw new LlmNotConfiguredError(
    'No LLM backend found. Set an API key (ANTHROPIC_API_KEY or OPENAI_API_KEY), point LLM_BASE_URL at an ' +
      'OpenAI-compatible endpoint, or run a local model (Ollama / LM Studio). Desktop chat apps cannot be used.',
  );
}
