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
  /** %LOCALAPPDATA%\APHub | ~/Library/Application Support/APHub — absolute, user-scoped. */
  dataDir(): string;
  logDir(): string;
  secretStore: SecretStore;
  spawnChild(spec: ChildSpec): ChildHandle;
  /** Task Scheduler task | LaunchAgent — non-elevated. */
  registerAutostart(cmd: string): Promise<void>;
  unregisterAutostart(): Promise<void>;
  fsPermissions: FsPermissions;
  probePort(port: number): Promise<PortProbe>;
}
