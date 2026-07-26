/**
 * OS-neutral HostAdapter seam (CHUNK_7). Everything OS-specific in the pilot is forced
 * through this interface so the Windows pilot cannot hard-code an assumption that blocks
 * macOS. Windows is the Phase-1A reference impl; macOS is compiled + type-checked in 1A
 * and exercised in 1B. See ARCHITECTURE-ap-hub-platform.md §3.
 *
 * This module and everything under src/host/** are the ONLY place OS-specific identifiers
 * may appear (enforced by `npm run lint:noleak`).
 */

export type OsId = 'windows' | 'macos';

/**
 * Platform identifiers as they are PERSISTED — in `install.json` and in
 * `local_install.platform`. These are Node's `process.platform` values rather than `OsId`,
 * because the migration's CHECK constraint is written against them.
 *
 * They live here, in the one directory the OS-boundary scan exempts, so that core modules can
 * validate the field without naming an operating system themselves. Windows-only Version 1 is a
 * scope reduction, not a licence to leak `win32` through `src/**` — see
 * `docs/decisions/windows-only-v1-2026-07-25.md`.
 *
 * `darwin` is retained in the union because migration 014 already accepts it and the abstraction
 * is deliberately preserved; nothing in Version 1 may WRITE it (enforced by
 * `SUPPORTED_PLATFORMS`).
 */
export const PERSISTED_PLATFORMS = ['win32', 'darwin'] as const;
export type PersistedPlatform = (typeof PERSISTED_PLATFORMS)[number];

/** What Version 1 will actually accept and write. Windows only. */
export const SUPPORTED_PLATFORMS = ['win32'] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** A user-scoped Windows Generic Credential target; values are never embedded here. */
export type CredentialTarget = `APHub/${string}/${string}`;

export const CREDENTIAL_TARGET_PATTERN = /^APHub\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

export function assertCredentialTarget(target: string): asserts target is CredentialTarget {
  if (!CREDENTIAL_TARGET_PATTERN.test(target)) {
    throw new Error('INVALID_CREDENTIAL_TARGET');
  }
}

/** Runtime secret authority. Implementations must never persist or report values. */
export interface SecretStore {
  put(target: string, secret: string): Promise<void>;
  get(target: string): Promise<string | null>;
  delete(target: string): Promise<void>;
  /** Returns target identifiers only; credential values are never enumerated. */
  listTargets?(prefix?: `APHub/${string}`): Promise<CredentialTarget[]>;
}

export interface ChildSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Human label for logs / heartbeat detail (a safe status code, never business data). */
  label: string;
}

export interface ChildHandle {
  readonly pid: number | undefined;
  readonly label: string;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface FsPermissions {
  /** Lock a directory down to the current user (ACL on Windows, POSIX 0700 on macOS). */
  restrictToCurrentUser(dir: string): Promise<void>;
}

export interface PortProbe {
  free: boolean;
  pid?: number;
  name?: string;
}

export interface HostAdapter {
  readonly os: OsId;
  /**
   * The value this OS writes to `install.json.platform` and `local_install.platform`.
   * Lives here so core modules can persist the field without naming an operating system.
   */
  readonly persistedPlatform: PersistedPlatform;
  /**
   * Filename suffix for a bundled executable (`.exe` on Windows, empty elsewhere). The
   * database runtime takes this as an option so `src/db/**` names no platform.
   */
  readonly exeSuffix: string;
  /** %LOCALAPPDATA%\APHub | ~/Library/Application Support/APHub — absolute, user-scoped. */
  dataDir(): string;
  logDir(): string;
  /**
   * Where the bundled PostgreSQL executables sit beneath a packaged resource root. The
   * caller supplies the root because only the shell knows whether it is running packaged
   * or from a developer checkout; the adapter knows only the layout beneath it.
   */
  postgresBinDir(resourceRoot: string): string;
  /**
   * Stable identifier for the OS account that owns this install — the Windows SID or the
   * macOS UID. CHUNK_4 makes this the product's identity anchor; CHUNK_2 records it in
   * `install.json` so a later account mismatch can fail closed.
   */
  osAccountId(): Promise<string>;
  secretStore: SecretStore;
  spawnChild(spec: ChildSpec): ChildHandle;
  /** Task Scheduler task | LaunchAgent — non-elevated. */
  registerAutostart(cmd: string): Promise<void>;
  unregisterAutostart(): Promise<void>;
  fsPermissions: FsPermissions;
  probePort(port: number): Promise<PortProbe>;
}
