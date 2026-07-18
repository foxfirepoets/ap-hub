import type { HostAdapter, OsId } from './types.js';
import { createWindowsHostAdapter } from './windows.js';
import { createMacosHostAdapter } from './macos.js';

export * from './types.js';
export { createWindowsHostAdapter } from './windows.js';
export { createMacosHostAdapter } from './macos.js';

/** Resolve the HostAdapter for the current OS. macOS is compiled in 1A, exercised in 1B. */
export function detectOs(): OsId {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  throw new Error(`Unsupported OS for the pilot host adapter: ${process.platform}`);
}

export function createHostAdapter(os: OsId = detectOs()): HostAdapter {
  return os === 'windows' ? createWindowsHostAdapter() : createMacosHostAdapter();
}
