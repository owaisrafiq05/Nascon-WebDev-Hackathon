import mongoose from 'mongoose';

import { loadWorkerConfig } from './config.js';
import { createLogger } from './logger.js';
import { createTicker } from './ticker.js';

/**
 * The worker process. For now its tick only logs a heartbeat, which proves the
 * process is alive and connected to the same database as the server.
 *
 * From P4 the tick claims due `scheduled_jobs` with a lease and runs escalations;
 * the loop shape (no overlap, errors contained) is already the one that needs.
 */
async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createLogger(config);

  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ database: mongoose.connection.name, env: config.env }, 'worker connected');

  const ticker = createTicker({
    intervalMs: config.heartbeatMs,
    runImmediately: true,
    onTick: ({ tick }) => {
      logger.info({ tick, databaseReadyState: mongoose.connection.readyState }, 'worker heartbeat');
    },
    onError: (error, { tick }) => {
      logger.error({ err: error, tick }, 'worker tick failed');
    },
  });

  ticker.start();
  logger.info({ intervalMs: config.heartbeatMs }, 'heartbeat started');

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    void ticker
      .stop()
      .then(() => mongoose.disconnect())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'failed to shut down cleanly');
        process.exit(1);
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
