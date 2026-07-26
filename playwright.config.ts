import { defineConfig } from '@playwright/test';

// CHUNK_3_IPC completed the migration off the browser + HTTP-mock project (`e2e/app.spec.ts`,
// `chromium`): the renderer only ever talks to AP-Hub over `window.aphub.invoke` now, so a
// plain-Chromium journey suite driving a `next start`-served export was testing a transport the
// product no longer has. Every journey that project covered now lives under `e2e-desktop/**`,
// driving a real Electron process via `_electron.launch` with `ipcMain` channel overrides in
// place of `page.route`. No browser project, no web server, no `next start` — the `desktop`
// project needs neither.
export default defineConfig({
  testDir: './e2e-desktop',
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
  projects: [
    // CHUNK_1_SHELL — drives a real Electron process; needs no browser and no web server.
    { name: 'desktop' },
  ],
});
