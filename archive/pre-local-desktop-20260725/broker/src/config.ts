import { z } from 'zod';

/**
 * Typed broker configuration (Zod). Mirrors ap-hub's `src/config.ts` shape.
 *
 * The broker holds Ben's upstream keys (Anthropic + SwarmSync) in its host
 * environment and nowhere else. Keys are OPTIONAL at config load in this chunk
 * (CHUNK_2 is auth + skeleton only; the proxy routes that need them arrive in
 * CHUNK_3), so the server + CLI + migrations boot without them for testing.
 */

const RawSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Upstream keys — set in the Render environment only. Optional here so the
  // auth skeleton, CLI, and migrations run without them (proxy routes: CHUNK_3).
  ANTHROPIC_API_KEY: z.string().default(''),
  SWARMSYNC_API_KEY: z.string().default(''),
  SWARMSYNC_API_BASE: z.string().url().default('https://api.swarmsync.ai'),
  SWARMSYNC_WEB_BASE: z.string().url().default('https://swarmsync.ai'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Config = z.infer<typeof RawSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = RawSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid broker configuration:\n${issues}`);
  }
  return parsed.data;
}

let cached: Config | null = null;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper — reset the memoized config. */
export function resetConfigCache(): void {
  cached = null;
}
