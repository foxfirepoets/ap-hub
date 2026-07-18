import { defineConfig } from 'vitest/config';

// Broker gate: DB-backed unit tests against a throwaway `aphub_broker` Postgres.
// No external service (Anthropic, SwarmSync) is contacted in this chunk — proxy
// routes arrive in CHUNK_3. Serial file execution keeps the shared scratch DB sane.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 20000,
    hookTimeout: 30000,
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
