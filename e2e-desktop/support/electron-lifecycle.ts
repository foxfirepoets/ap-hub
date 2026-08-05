import { _electron as electron, type ElectronApplication, type ElectronLaunchOptions } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** BookScout OS's `before-quit` path may stop PostgreSQL for up to ~20 s; quit must finish before the next launch. */
const SHUTDOWN_MS = 30_000;

/**
 * Close an Electron app and wait until its main process has fully exited.
 *
 * Playwright's `app.close()` alone can return while `desktop/main.ts`'s async `before-quit`
 * handler is still running. A follow-up `electron.launch` then hits
 * `requestSingleInstanceLock()` (`desktop/main.ts:443-444`), the second process exits with
 * code 0, and Playwright reports `electron.launch: WebSocket error: read ECONNRESET`.
 */
export async function closeElectron(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const proc = app.process();
  const exited = Promise.race([
    new Promise<void>((resolve) => app.once('close', resolve)),
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null) resolve();
      else proc.once('exit', () => resolve());
    }),
  ]);
  await Promise.race([
    app.close(),
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`app.close() did not settle within ${SHUTDOWN_MS}ms`)),
        SHUTDOWN_MS,
      ),
    ),
  ]).catch(async (err) => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
    throw err;
  });
  await Promise.race([
    exited,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Electron process did not exit within ${SHUTDOWN_MS}ms after close()`)),
        SHUTDOWN_MS,
      ),
    ),
  ]);
}

export type LaunchElectronOptions = Omit<ElectronLaunchOptions, 'args'> & {
  args?: string[];
  /** Separate Electron profile so single-instance lock does not collide with a prior test run. */
  userDataDir?: string;
};

export async function launchElectron(options: LaunchElectronOptions): Promise<ElectronApplication> {
  const extra = [...(options.args ?? [])];
  const args: string[] = [];
  // Electron treats the first non-option arg as the app entry. Put isolation flags first so
  // they are not swallowed after MAIN.
  if (options.userDataDir) {
    mkdirSync(options.userDataDir, { recursive: true });
    args.push(`--user-data-dir=${options.userDataDir}`);
  }
  args.push(...extra);
  const { userDataDir: _userDataDir, ...rest } = options;
  return electron.launch({ ...rest, args });
}

/** Redirect `%LOCALAPPDATA%` so bundled PostgreSQL does not share the product install root. */
export function isolatedLocalAppData(specName: string): string {
  const dir = join(process.cwd(), 'test-results', specName, 'localappdata');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function isolatedUserDataDir(specName: string): string {
  const dir = join(process.cwd(), 'test-results', specName, 'electron-user-data');
  mkdirSync(dir, { recursive: true });
  return dir;
}
