/**
 * macOS HostAdapter (CHUNK_7). Implemented + type-checked in Phase 1A so the Windows
 * work cannot hard-code assumptions that block macOS; EXERCISED on a real Mac in Phase 1B.
 * Non-elevated throughout: Keychain (per-user) for secrets, a LaunchAgent (not a
 * LaunchDaemon — no root) for autostart, `~/Library/Application Support/APHub` for data.
 */

import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChildHandle, ChildSpec, FsPermissions, HostAdapter, PortProbe, SecretStore } from './types.js';

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...extraEnv }, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString().trim()),
    );
  });
}

function appDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'APHub');
}

const KEYCHAIN_SERVICE = 'com.aphub.pilot';

class KeychainSecretStore implements SecretStore {
  async put(name: string, secret: string): Promise<void> {
    // -U updates if present. -w takes the secret; passed as an arg only on macOS (no
    // process-list threat model change from the pilot's perspective in 1B).
    await run('security', ['add-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE, '-w', secret, '-U']);
  }

  async get(name: string): Promise<string | null> {
    try {
      return await run('security', ['find-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE, '-w']);
    } catch {
      return null; // not found
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await run('security', ['delete-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE]);
    } catch {
      /* absent — nothing to delete */
    }
  }
}

const macosFsPermissions: FsPermissions = {
  async restrictToCurrentUser(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    await run('chmod', ['700', dir]);
  },
};

const LAUNCH_AGENT_LABEL = 'com.aphub.watchdog';
function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function createMacosHostAdapter(): HostAdapter {
  const secretStore = new KeychainSecretStore();
  return {
    os: 'macos',
    dataDir: appDataDir,
    logDir: () => join(homedir(), 'Library', 'Logs', 'APHub'),
    secretStore,
    fsPermissions: macosFsPermissions,

    spawnChild(spec: ChildSpec): ChildHandle {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
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
      // `cmd` is the path to the LaunchAgent plist. `launchctl load` runs it in the
      // user's session (RunAtLoad + KeepAlive), never as root.
      await run('launchctl', ['load', '-w', cmd]);
    },

    async unregisterAutostart(): Promise<void> {
      await run('launchctl', ['unload', '-w', launchAgentPath()]).catch(() => undefined);
    },

    async probePort(port: number): Promise<PortProbe> {
      try {
        const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
        if (!out) return { free: true };
        const pidLine = out.split('\n').find((l) => l.startsWith('p'));
        const nameLine = out.split('\n').find((l) => l.startsWith('c'));
        return {
          free: false,
          pid: pidLine ? Number(pidLine.slice(1)) || undefined : undefined,
          name: nameLine ? nameLine.slice(1) : undefined,
        };
      } catch {
        return { free: true }; // lsof exits non-zero when nothing is listening
      }
    },
  };
}
