/**
 * CHUNK_2_DATABASE — the shell's side of the private database.
 *
 * `src/db/local-database.ts` owns the ordering and the safety rules; this file owns only the
 * question that module deliberately refuses to answer: WHERE things are. That split is what
 * keeps `lint:noleak` green — the engine names no operating system and no packaging layout,
 * and the shell, which is allowed to know both, supplies them.
 *
 * Two location questions, two different answers depending on how the app was started:
 *
 *   packaged  → binaries and migrations are unpacked beside the asar, under `resourcesPath`.
 *   developer → they are in the repository working tree.
 *
 * `app.isPackaged` is the only thing that distinguishes the two, and it is asked once here
 * rather than threaded through the engine.
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostAdapter, type HostAdapter } from '../src/host/index.js';
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from '../src/host/types.js';
import {
  startLocalDatabase,
  DatabasePasswordLost,
  type LocalPostgres,
  type StartedLocalDatabase,
} from '../src/db/local-database.js';
import { migrateUp } from '../src/db/migrate.js';

/** This file's own build output directory: `<root>/dist-desktop` in a checkout. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Root beneath which the bundled PostgreSQL and the migrations ship.
 *
 * Development deliberately does NOT use `app.getAppPath()`. Electron sets the app path to
 * the directory CONTAINING the entry script, so launching `electron dist-desktop/main.mjs`
 * makes it `<root>/dist-desktop` rather than `<root>` — which resolved the PostgreSQL bin
 * directory to `dist-desktop/pgsql/bin`, a path that has never existed. Deriving the root
 * from this module's own location instead is exact: the build always emits to
 * `<root>/dist-desktop`, so its parent is the checkout root regardless of how Electron was
 * invoked or what the working directory is.
 */
export function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : dirname(HERE);
}

export function migrationsDir(): string {
  return join(resourceRoot(), 'migrations');
}

/** Where the trimmed PostgreSQL tree lands. Mirrors `extraResources` in electron-builder.yml. */
export function postgresRoot(): string {
  // In a developer checkout the bundle script writes to `vendor/`; the packaged build
  // flattens that away, so both are accepted and the packaged location wins.
  const packaged = resourceRoot();
  const vendored = join(packaged, 'vendor');
  return existsSync(join(vendored, 'pgsql')) ? vendored : packaged;
}

/**
 * Plain-language failure. The user is non-technical: they never see a port, a password, a
 * migration or a stack trace — only what happened and what to do next.
 */
export interface DatabaseFailure {
  code: 'DB_FAILED';
  message: string;
  /** True when the user's data still exists and repair/restore is the right next step. */
  repairable: boolean;
}

export function describeDatabaseFailure(err: unknown): DatabaseFailure {
  if (err instanceof DatabasePasswordLost) {
    return {
      code: 'DB_FAILED',
      message:
        'AP-Hub found your information but could not unlock it on this Windows account. ' +
        'Restoring from a backup will recover it.',
      repairable: true,
    };
  }
  return {
    code: 'DB_FAILED',
    message:
      'AP-Hub could not start its private database. Restarting AP-Hub usually fixes this. ' +
      'If it keeps happening, use Repair in Settings.',
    repairable: false,
  };
}

/** Version 1 runs on Windows only; anything else fails closed rather than half-working. */
function supportedPlatformOrThrow(host: HostAdapter): SupportedPlatform {
  const platform = host.persistedPlatform;
  if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
    throw new Error('UNSUPPORTED_PLATFORM');
  }
  return platform as SupportedPlatform;
}

export interface StartDatabaseOptions {
  host?: HostAdapter;
  appVersion?: string;
}

/**
 * Bring the private database up for this install. Called once, during `whenReady`, before
 * the engine and before the window claims to be usable.
 */
export async function startDatabase(opts: StartDatabaseOptions = {}): Promise<StartedLocalDatabase> {
  const host = opts.host ?? createHostAdapter();
  const platform = supportedPlatformOrThrow(host);
  const dataRoot = host.dataDir();
  const dir = migrationsDir();
  const binDir = host.postgresBinDir(postgresRoot());

  /**
   * Check the binaries are where we think BEFORE trying to run them.
   *
   * `execFile` reports a missing executable as a failed spawn with empty stderr, which is
   * indistinguishable from "initdb ran and failed" in the log — the wrong diagnosis to hand
   * an operator, and the one this check exists to prevent. It also catches a packaging
   * mistake at launch rather than at first use.
   */
  const initdb = join(binDir, `initdb${host.exeSuffix}`);
  if (!existsSync(initdb)) {
    const err = new Error('PostgreSQL did not start: bundled runtime is missing') as Error & {
      code: string;
      detail: string;
    };
    err.code = 'DB_FAILED';
    err.detail = `expected ${initdb}\n  resourceRoot=${resourceRoot()}\n  postgresRoot=${postgresRoot()}\n  packaged=${app.isPackaged}`;
    throw err;
  }
  if (!existsSync(dir)) {
    const err = new Error('PostgreSQL did not start: migrations are missing') as Error & {
      code: string;
      detail: string;
    };
    err.code = 'DB_FAILED';
    err.detail = `expected ${dir}`;
    throw err;
  }

  await host.fsPermissions.restrictToCurrentUser(dataRoot);

  return startLocalDatabase({
    binDir,
    dataDir: join(dataRoot, 'pgdata'),
    installFilePath: join(dataRoot, 'install.json'),
    logDir: host.logDir(),
    exeSuffix: host.exeSuffix,
    platform,
    appVersion: opts.appVersion ?? app.getVersion(),
    osAccountId: await host.osAccountId(),
    secretStore: host.secretStore,
    migrate: (connectionString) => migrateUp(connectionString, dir),
  });
}

export type { LocalPostgres, StartedLocalDatabase };
