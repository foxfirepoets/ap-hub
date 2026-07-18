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
    if (cfg.BROKER_BASE_URL) {
      // BROKER MODE: the authed calls (Verify-API/AuditProof/chain-verify — the
      // ones that use the ssk_ key) route through the broker with the install
      // token as the bearer, so the SwarmSync key never lives on this machine.
      // The InvoiceProof scan is keyless (auth:false) and stays direct to the
      // public web base — no secret, no need to broker it. client.ts is unchanged.
      swarm = new SwarmSyncClient({
        apiBase: cfg.BROKER_BASE_URL,
        webBase: cfg.SWARMSYNC_WEB_BASE,
        apiKey: cfg.BROKER_INSTALL_TOKEN,
      });
    } else {
      swarm = new SwarmSyncClient({
        apiBase: cfg.SWARMSYNC_API_BASE,
        webBase: cfg.SWARMSYNC_WEB_BASE,
        apiKey: cfg.SWARMSYNC_API_KEY,
      });
    }
  }
  return swarm;
}

export function resetServicesForTest(): void {
  swarm = null;
}
