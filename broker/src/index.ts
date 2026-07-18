import { config } from './config.js';
import { createBrokerServer } from './server.js';
import { migrateUp } from './db.js';
import { logger } from './logger.js';

/**
 * Broker entrypoint. Applies migrations, then boots the HTTP server. Deployed on
 * Render (free web service + free Postgres); `PORT` and `DATABASE_URL` are injected
 * by the host. No business data is stored here — key custody + telemetry only.
 */
async function boot(): Promise<void> {
  const cfg = config();
  await migrateUp(cfg.DATABASE_URL);
  const server = createBrokerServer();
  server.listen(cfg.PORT, () => {
    logger.info({ port: cfg.PORT }, 'broker listening');
  });
}

boot().catch((err) => {
  logger.error({ err: String(err) }, 'broker failed to boot');
  process.exit(1);
});
