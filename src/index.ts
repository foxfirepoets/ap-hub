import { config } from './config.js';
import { logger } from './logger.js';
import { getPool, closePool } from './db/pool.js';
import { startQueue, stopQueue, getQueue, JOBS } from './queue.js';
import { createHttpServer } from './http.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerPipelineJobs } from './pipeline/register.js';

/**
 * Service boot: HTTP server (health + OAuth callbacks) + pg-boss workers in one
 * process. Exits cleanly on SIGINT. Idle until Gmail/QBO are connected and the
 * poller is scheduled.
 */
export async function boot(): Promise<() => Promise<void>> {
  const cfg = config();
  getPool(cfg.DATABASE_URL);

  const boss = await startQueue(cfg.DATABASE_URL);

  // Trivial no-op job proves the queue round-trips (CHUNK_1 acceptance).
  await boss.work(JOBS.noop, async () => {
    logger.debug('noop job ran');
  });

  await registerPipelineJobs(boss, cfg);

  const server = createHttpServer();
  registerAuthRoutes();

  // QuickBooks Desktop (Web Connector) SOAP endpoint — opt-in, read-only default.
  const { registerQbDesktop } = await import('./qbdesktop/index.js');
  registerQbDesktop(cfg);
  await new Promise<void>((resolve) => server.listen(cfg.PORT, resolve));
  logger.info({ port: cfg.PORT, qboEnv: cfg.QBO_ENV }, 'ap-hub service listening');

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopQueue();
    await closePool();
  };

  return shutdown;
}

async function main(): Promise<void> {
  const shutdown = await boot();
  const onSignal = async () => {
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  main().catch((err) => {
    logger.error({ err: String(err) }, 'boot failed');
    process.exit(1);
  });
}

export { getQueue };
