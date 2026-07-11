import { config } from './config.js';
import { SwarmSyncClient } from './swarmsync/client.js';

/**
 * Composition root for external-service clients built from config. Jobs and the CLI
 * pull dependencies from here; tests construct their own with mocked fetch.
 */

let swarm: SwarmSyncClient | null = null;

export function swarmsync(): SwarmSyncClient {
  if (!swarm) {
    const cfg = config();
    swarm = new SwarmSyncClient({
      apiBase: cfg.SWARMSYNC_API_BASE,
      webBase: cfg.SWARMSYNC_WEB_BASE,
      apiKey: cfg.SWARMSYNC_API_KEY,
    });
  }
  return swarm;
}

export function resetServicesForTest(): void {
  swarm = null;
}
