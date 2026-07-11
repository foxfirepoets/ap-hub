import { defineConfig } from 'vitest/config';

// Integration tests (DB / live-service) are tagged with `.int.test.ts` and only
// run in integration mode (`npm run test:int`). The default `npm test` gate runs
// unit tests, which use an ephemeral local Postgres when available and mocks for
// all external services (SwarmSync, Gmail, QBO, Telegram, Anthropic).
const integration = process.argv.includes('--mode') && process.argv.includes('integration');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: integration
      ? ['test/**/*.int.test.ts']
      : ['test/**/*.test.ts'],
    exclude: integration ? [] : ['test/**/*.int.test.ts', 'node_modules/**'],
    testTimeout: 20000,
    hookTimeout: 30000,
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
