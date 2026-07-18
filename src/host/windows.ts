/**
 * Windows HostAdapter (CHUNK_7). Non-elevated throughout: DPAPI (CurrentUser) for the
 * secret store, Task Scheduler (per-user) for autostart, `%LOCALAPPDATA%\APHub` for data,
 * `Get-NetTCPConnection` for port probes, `icacls` to lock the data dir to the user.
 * No admin rights are ever requested.
 */

import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildHandle, ChildSpec, FsPermissions, HostAdapter, PortProbe, SecretStore } from './types.js';

function runPowerShell(script: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...extraEnv }, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.toString().trim())),
    );
  });
}

function appDataDir(): string {
  const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');
  return join(base, 'APHub');
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

class DpapiSecretStore implements SecretStore {
  private dir = join(appDataDir(), 'secrets');

  private file(name: string): string {
    return join(this.dir, `${safeName(name)}.dpapi`);
  }

  async put(name: string, secret: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    // DPAPI-encrypt under the current user. The plaintext is passed via env, never the
    // command line (which would be visible in the process list).
    const b64 = await runPowerShell(
      `Add-Type -AssemblyName System.Security;` +
        `$b=[System.Text.Encoding]::UTF8.GetBytes($env:APHUB_SECRET_IN);` +
        `$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');` +
        `[Convert]::ToBase64String($e)`,
      { APHUB_SECRET_IN: secret },
    );
    writeFileSync(this.file(name), b64, { encoding: 'utf8' });
  }

  async get(name: string): Promise<string | null> {
    const f = this.file(name);
    if (!existsSync(f)) return null;
    const b64 = readFileSync(f, 'utf8').trim();
    return runPowerShell(
      `Add-Type -AssemblyName System.Security;` +
        `$e=[Convert]::FromBase64String($env:APHUB_SECRET_B64);` +
        `$d=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser');` +
        `[System.Text.Encoding]::UTF8.GetString($d)`,
      { APHUB_SECRET_B64: b64 },
    );
  }

  async delete(name: string): Promise<void> {
    const f = this.file(name);
    if (existsSync(f)) rmSync(f);
  }
}

const windowsFsPermissions: FsPermissions = {
  async restrictToCurrentUser(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    // Disable inheritance, grant the current user full control only. Non-elevated: a user
    // can always re-ACL a directory they own.
    await runPowerShell(
      `icacls "${dir}" /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null`,
    );
  },
};

const TASK_NAME = 'APHubWatchdog';

export function createWindowsHostAdapter(): HostAdapter {
  const secretStore = new DpapiSecretStore();
  return {
    os: 'windows',
    dataDir: appDataDir,
    logDir: () => join(appDataDir(), 'logs'),
    secretStore,
    fsPermissions: windowsFsPermissions,

    spawnChild(spec: ChildSpec): ChildHandle {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        windowsHide: true,
        stdio: 'ignore',
      });
      return {
        pid: child.pid,
        label: spec.label,
        onExit: (cb) => child.on('exit', cb),
        kill: () => child.kill(),
      };
    },

    async registerAutostart(cmd: string): Promise<void> {
      // Register the non-elevated on-logon + 5-min task from aphub-watchdog.xml. `cmd`
      // is the path to the task XML. schtasks with no /RU SYSTEM stays in the user context.
      await runPowerShell(`schtasks /Create /TN "${TASK_NAME}" /XML "${cmd}" /F | Out-Null`);
    },

    async unregisterAutostart(): Promise<void> {
      await runPowerShell(`schtasks /Delete /TN "${TASK_NAME}" /F 2>$null; exit 0`);
    },

    async probePort(port: number): Promise<PortProbe> {
      const out = await runPowerShell(
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;` +
          `if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; ` +
          `Write-Output ("{0}|{1}" -f $c.OwningProcess, $p.ProcessName) } else { Write-Output "" }`,
      );
      if (!out) return { free: true };
      const [pidStr, name] = out.split('|');
      return { free: false, pid: Number(pidStr) || undefined, name: name || undefined };
    },
  };
}
