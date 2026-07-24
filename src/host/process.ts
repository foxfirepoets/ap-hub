import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  type SpawnSyncOptions,
} from 'node:child_process';

/** OS-specific shell selection belongs behind the host boundary. */
function hostShell(): boolean {
  return process.platform === 'win32';
}

export function spawnPortable(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { ...options, shell: hostShell() });
}

export function spawnSyncPortable(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
) {
  return spawnSync(command, [...args], { ...options, shell: hostShell() });
}
