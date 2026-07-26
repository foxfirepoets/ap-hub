import { defineConfig, devices } from '@playwright/test';

// E2E for the CHUNK_5 frontend. The app is built and served by `next start`; every /api/**
// call and the Google login redirect are STUBBED in the spec (page.route), so the behavioral
// journey (login → Today → exception → evidence → approve → Posted + QBO link) runs without a
// live database or a real Google account. Real auth/data are covered by the src gate + build.
function e2ePort(value: string | undefined): number {
  if (value === undefined || value === '') return 3100;
  if (!/^\d{4,5}$/.test(value)) throw new Error('APHUB_E2E_PORT must be a numeric unprivileged TCP port');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('APHUB_E2E_PORT must be between 1024 and 65535');
  }
  return port;
}

const PORT = e2ePort(process.env.APHUB_E2E_PORT);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  /**
   * One worker, because AP-Hub holds a single-instance lock (desktop/main.ts): a second
   * Electron process quits immediately rather than supervising a second PostgreSQL over the
   * same data directory. That is correct product behaviour, so the suite must not run two
   * desktop spec FILES at once — with the default worker count they land in parallel workers
   * and the second app exits before its first assertion.
   */
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [
    { name: 'chromium', testDir: './e2e', use: { ...devices['Desktop Chrome'] } },
    // CHUNK_1_SHELL — drives a real Electron process; needs no browser and no web server.
    { name: 'desktop', testDir: './e2e-desktop' },
  ],
  webServer: {
    /**
     * Build then serve the exported renderer. `next start` is gone because there is nothing for
     * it to start: CHUNK_3 exports the React tree to plain files (`output: 'export'`) and the real
     * app loads them off disk, so the only thing that can serve them over HTTP is a plain file
     * server. It exists solely for the BROWSER project below; the desktop project needs no server
     * at all, and this whole block retires with `e2e/app.spec.ts`.
     */
    // `npm run web:build`, not a bare `next build`: the export is only complete once the inline
    // scripts have been externalized, without which nothing starts under the window's script
    // policy (scripts/externalize-inline-scripts.mjs).
    command: `npm run web:build && npx tsx scripts/serve-web-export.mts ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
