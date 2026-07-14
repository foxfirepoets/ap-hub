import { defineConfig, devices } from '@playwright/test';

// E2E for the CHUNK_5 frontend. The app is built and served by `next start`; every /api/**
// call and the Google login redirect are STUBBED in the spec (page.route), so the behavioral
// journey (login → Today → exception → evidence → approve → Posted + QBO link) runs without a
// live database or a real Google account. Real auth/data are covered by the src gate + build.
const PORT = 3100;

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build then serve the production app. Reuses a running server locally.
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
