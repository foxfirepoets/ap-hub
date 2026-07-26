/**
 * Windows HostAdapter. Non-elevated throughout: Credential Manager Generic Credentials
 * for the current-user secret store, Task Scheduler (per-user) for autostart, `%LOCALAPPDATA%\APHub` for data,
 * `Get-NetTCPConnection` for port probes, `icacls` to lock the data dir to the user.
 * No admin rights are ever requested.
 */

import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertCredentialTarget,
  type ChildHandle,
  type ChildSpec,
  type CredentialTarget,
  type FsPermissions,
  type HostAdapter,
  type PortProbe,
  type SecretStore,
} from './types.js';

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

const CREDENTIAL_MANAGER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (-not ('APHub.NativeCredentialManager' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace APHub {
  public static class NativeCredentialManager {
    const int CRED_TYPE_GENERIC = 1;
    const int CRED_PERSIST_LOCAL_MACHINE = 2;
    const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
      public uint Flags; public uint Type; public string TargetName; public string Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
      public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
    [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("Advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);
    [DllImport("Advapi32.dll", EntryPoint="CredFree", SetLastError=false)]
    static extern void CredFree(IntPtr buffer);

    public static void Put(string target, string value) {
      byte[] bytes = Encoding.UTF8.GetBytes(value);
      if (bytes.Length > 2560) throw new ArgumentException("CREDENTIAL_VALUE_TOO_LARGE");
      IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);
      try {
        if (bytes.Length > 0) Marshal.Copy(bytes, 0, blob, bytes.Length);
        var credential = new CREDENTIAL {
          Type=CRED_TYPE_GENERIC, TargetName=target, CredentialBlobSize=(uint)bytes.Length,
          CredentialBlob=blob, Persist=CRED_PERSIST_LOCAL_MACHINE, UserName=Environment.UserName
        };
        if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CREDENTIAL_WRITE_FAILED");
      } finally {
        if (bytes.Length > 0) {
          Array.Clear(bytes, 0, bytes.Length);
          Marshal.Copy(bytes, 0, blob, bytes.Length);
        }
        Marshal.FreeCoTaskMem(blob);
      }
    }

    public static string Get(string target) {
      IntPtr ptr;
      if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {
        int code = Marshal.GetLastWin32Error();
        if (code == ERROR_NOT_FOUND) return null;
        throw new Win32Exception(code, "CREDENTIAL_READ_FAILED");
      }
      try {
        var credential = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
        if (credential.CredentialBlobSize == 0) return "";
        byte[] bytes = new byte[credential.CredentialBlobSize];
        Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
        try { return Encoding.UTF8.GetString(bytes); }
        finally { Array.Clear(bytes, 0, bytes.Length); }
      } finally { CredFree(ptr); }
    }

    public static void Delete(string target) {
      if (CredDelete(target, CRED_TYPE_GENERIC, 0)) return;
      int code = Marshal.GetLastWin32Error();
      if (code != ERROR_NOT_FOUND) throw new Win32Exception(code, "CREDENTIAL_DELETE_FAILED");
    }

    public static string[] List(string prefix) {
      uint count; IntPtr array;
      if (!CredEnumerate(prefix + "*", 0, out count, out array)) {
        int code = Marshal.GetLastWin32Error();
        if (code == ERROR_NOT_FOUND) return new string[0];
        throw new Win32Exception(code, "CREDENTIAL_ENUMERATE_FAILED");
      }
      try {
        var result = new List<string>();
        for (int i=0; i<count; i++) {
          IntPtr item = Marshal.ReadIntPtr(array, i * IntPtr.Size);
          var credential = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
          if (credential.Type == CRED_TYPE_GENERIC) result.Add(credential.TargetName);
        }
        return result.ToArray();
      } finally { CredFree(array); }
    }
  }
}
'@
}
switch ([string]$request.operation) {
  'put' { [APHub.NativeCredentialManager]::Put([string]$request.target, [string]$request.value); @{ok=$true} | ConvertTo-Json -Compress }
  'get' { $v=[APHub.NativeCredentialManager]::Get([string]$request.target); @{ok=$true;found=($null -ne $v);value=$v} | ConvertTo-Json -Compress }
  'delete' { [APHub.NativeCredentialManager]::Delete([string]$request.target); @{ok=$true} | ConvertTo-Json -Compress }
  'list' { @{ok=$true;targets=@([APHub.NativeCredentialManager]::List([string]$request.prefix))} | ConvertTo-Json -Compress }
  default { throw 'CREDENTIAL_OPERATION_INVALID' }
}`;

function runCredentialManager(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CREDENTIAL_MANAGER_SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.stdin.setDefaultEncoding('utf8');
    child.once('error', () => reject(new Error('WINDOWS_CREDENTIAL_MANAGER_UNAVAILABLE')));
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`WINDOWS_CREDENTIAL_MANAGER_FAILED:${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
      } catch {
        reject(new Error('WINDOWS_CREDENTIAL_MANAGER_INVALID_RESPONSE'));
      }
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

export class WindowsCredentialManagerSecretStore implements SecretStore {
  async put(target: string, secret: string): Promise<void> {
    assertCredentialTarget(target);
    await runCredentialManager({ operation: 'put', target, value: secret });
  }

  async get(target: string): Promise<string | null> {
    assertCredentialTarget(target);
    const result = await runCredentialManager({ operation: 'get', target });
    return result.found === true && typeof result.value === 'string' ? result.value : null;
  }

  async delete(target: string): Promise<void> {
    assertCredentialTarget(target);
    await runCredentialManager({ operation: 'delete', target });
  }

  async listTargets(prefix: `APHub/${string}` = 'APHub/'): Promise<CredentialTarget[]> {
    if (!/^APHub\/[A-Za-z0-9_-]*\/?$/.test(prefix)) throw new Error('INVALID_CREDENTIAL_PREFIX');
    const result = await runCredentialManager({ operation: 'list', prefix });
    return Array.isArray(result.targets)
      ? result.targets.filter((target): target is CredentialTarget =>
          typeof target === 'string' && /^APHub\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(target))
      : [];
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

/**
 * The account's SID rather than its name. A Windows account can be renamed; its SID cannot,
 * so the SID is the only identifier that stays true across a rename and therefore the only
 * one an ownership check may fail closed on.
 */
async function windowsAccountId(): Promise<string> {
  const sid = await runPowerShell(
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  );
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('OS_ACCOUNT_ID_UNAVAILABLE');
  return sid;
}

export function createWindowsHostAdapter(): HostAdapter {
  const secretStore = new WindowsCredentialManagerSecretStore();
  return {
    os: 'windows',
    persistedPlatform: 'win32',
    exeSuffix: '.exe',
    dataDir: appDataDir,
    logDir: () => join(appDataDir(), 'logs'),
    postgresBinDir: (resourceRoot: string) => join(resourceRoot, 'pgsql', 'bin'),
    osAccountId: windowsAccountId,
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
