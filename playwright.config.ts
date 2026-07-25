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
    // Build then serve the production app. Reuses a running server locally.
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
