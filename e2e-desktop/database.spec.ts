import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CHUNK_2_DATABASE — the private database proved from a REAL Electron process.
 *
 * Unit tests prove the ordering, and `test/local-database.int.test.ts` proves the bundled
 * server starts when called directly. Neither proves the thing the chunk actually promises:
 * that double-clicking AP-Hub results in a running, migrated database. This does — it launches
 * the packaged main process, waits for the shell to report itself running, and then verifies
 * the cluster, the install file and the migrated schema from outside the app.
 *
 * It exercises the real `%LOCALAPPDATA%\APHub` location and the real Windows Credential
 * Manager on purpose. A proof against a redirected data directory would not be a proof of
 * first launch; it would be a proof of the test harness.
 *
 * Requires `node scripts/bundle-postgres.mjs` to have produced `vendor/pgsql`.
 */

const MAIN = join(process.cwd(), 'dist-desktop', 'main.mjs');
const DATA_ROOT = join(process.env.LOCALAPPDATA ?? '', 'APHub');
const INSTALL_FILE = join(DATA_ROOT, 'install.json');
const PGDATA = join(DATA_ROOT, 'pgdata');

const BUNDLE_PRESENT = existsSync(join(process.cwd(), 'vendor', 'pgsql', 'bin', 'initdb.exe'));

interface ShellStatus {
  ok: boolean;
  data: { engine: string; label: string; database: string; problem: string | null };
}

let app: ElectronApplication;
let win: Page;

test.describe('bundled database under a real Electron process', () => {
  test.skip(!BUNDLE_PRESENT, 'vendor/pgsql absent — run: node scripts/bundle-postgres.mjs');
  // First launch runs initdb (~13 s measured) plus migrations, then a graceful shutdown.
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    // A hook does not inherit the describe timeout, and first launch legitimately takes
    // longer than the default: `initdb` alone was measured at ~12 s.
    test.setTimeout(240_000);
    app = await electron.launch({ args: [MAIN] });
    // Surface main-process output — without it a failure to start the database is invisible
    // here and shows up only as a hook timeout.
    app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on('data', (d) => process.stdout.write(`[main:err] ${d}`));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the shell reaches "running" with its private database ready', async () => {
    const status = await expect
      .poll(
        async () => {
          const res = (await win.evaluate(() =>
            (window as unknown as { aphub: { invoke: (c: string) => Promise<ShellStatus> } }).aphub.invoke(
              'aphub:shell:status',
            ),
          )) as ShellStatus;
          return res.data;
        },
        { timeout: 200_000, intervals: [1000] },
      )
      .toMatchObject({ engine: 'running', database: 'ready' })
      .then(() =>
        win.evaluate(() =>
          (window as unknown as { aphub: { invoke: (c: string) => Promise<ShellStatus> } }).aphub.invoke(
            'aphub:shell:status',
          ),
        ),
      );

    // Plain language only — no port, no path, no code reaches the renderer.
    expect((status as ShellStatus).data.label).toBe('AP-Hub is running');
    expect((status as ShellStatus).data.problem).toBeNull();
  });

  test('the startup screen stops saying "starting up" once the database is up', async () => {
    // The page began as static markup. When the database failed, the owner was left on
    // "AP-Hub is starting up" indefinitely with no explanation — a dead end. This asserts the
    // screen actually follows the supervisor's state.
    await expect(win.locator('#boot-heading')).toHaveText('AP-Hub is ready.', { timeout: 30_000 });
    await expect(win.locator('#boot-bar')).toBeHidden();
  });

  test('a real cluster exists in the install"s private data directory', async () => {
    expect(existsSync(PGDATA)).toBe(true);
    expect(existsSync(join(PGDATA, 'PG_VERSION'))).toBe(true);
    expect(readFileSync(join(PGDATA, 'PG_VERSION'), 'utf8').trim()).toBe('16');
    // The interrupted-initialisation sentinel must be gone once the cluster is real.
    expect(existsSync(join(DATA_ROOT, '.aphub-initialising-pgdata'))).toBe(false);
  });

  test('install.json records a private port and carries no credential', async () => {
    expect(existsSync(INSTALL_FILE)).toBe(true);
    const raw = readFileSync(INSTALL_FILE, 'utf8');
    const file = JSON.parse(raw) as Record<string, unknown>;

    expect(typeof file.installId).toBe('string');
    expect(file.platform).toBe('win32');
    expect(typeof file.dbPort).toBe('number');
    expect(file.dbPort as number).toBeGreaterThanOrEqual(55432);
    expect(file.dbPort).not.toBe(5432);
    // Windows SID of the installing account.
    expect(String(file.osAccountId)).toMatch(/^S-1-/);

    // No credential-shaped key may appear, under any spelling.
    for (const key of Object.keys(file)) {
      expect(key.toLowerCase()).not.toMatch(/secret|token|password|passwd|pwd|credential|key/);
    }
  });

  test('the database is listening only on loopback, on its own port', async () => {
    const file = JSON.parse(readFileSync(INSTALL_FILE, 'utf8')) as { dbPort: number };
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${file.dbPort} -State Listen | Select-Object -ExpandProperty LocalAddress`,
      ],
      { encoding: 'utf8' },
    );
    const addresses = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    expect(addresses.length).toBeGreaterThan(0);
    // Loopback only — never 0.0.0.0 or a LAN address.
    for (const a of addresses) expect(['127.0.0.1', '::1']).toContain(a);
  });

  test('the migrated schema is reachable on that port with the stored password', async () => {
    const file = JSON.parse(readFileSync(INSTALL_FILE, 'utf8')) as { dbPort: number; installId: string };
    const { WindowsCredentialManagerSecretStore } = await import('../src/host/windows.js');
    const password = await new WindowsCredentialManagerSecretStore().get('APHub/database/superuser');
    expect(password).toBeTruthy();

    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: `postgres://aphub:${encodeURIComponent(password!)}@127.0.0.1:${file.dbPort}/aphub`,
    });
    try {
      const { rows } = await pool.query<{ install_id: string; db_port: number }>(
        'SELECT install_id, db_port FROM local_install',
      );
      expect(rows).toHaveLength(1);
      // The database and the file agree — neither was written without the other.
      expect(rows[0]?.install_id).toBe(file.installId);
      expect(rows[0]?.db_port).toBe(file.dbPort);

      const applied = await pool.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
      const names = applied.rows.map((r) => r.name);
      expect(names).toContain('014_local_install.sql');
      expect(names).toContain('015_backups.sql');
    } finally {
      await pool.end();
    }
  });
});
