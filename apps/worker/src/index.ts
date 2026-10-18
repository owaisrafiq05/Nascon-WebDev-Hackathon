import { runDueJobs } from '@ubmp/server/jobs';
import mongoose from 'mongoose';

import { loadWorkerConfig } from './config.js';
import { createLogger } from './logger.js';
import { createTicker } from './ticker.js';

/**
 * The worker process (F3.5, Q5).
 *
 * Each tick claims due `scheduled_jobs` with a lease and runs them, which is
 * what makes escalation happen without anyone's browser being open. The loop
 * cannot overlap, so two ticks never race for the same job; the lease means two
 * *workers* cannot either, and a lease that expires because a worker died is
 * re-claimed by the next one.
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
    onTick: async ({ tick }) => {
      const results = await runDueJobs({ maxJobs: 50 });

      if (results.length === 0) {
        // Debug, so an idle worker does not fill the log.
        logger.debug({ tick, databaseReadyState: mongoose.connection.readyState }, 'no jobs due');
        return;
      }

      logger.info(
        {
          tick,
          jobs: results.length,
          outcomes: results.map((result) => ({
            type: result.type,
            reason: 'reason' in result.outcome ? result.outcome.reason : 'handled',
          })),
        },
        'ran scheduled jobs',
      );
    },
    onError: (error, { tick }) => {
      logger.error({ err: error, tick }, 'worker tick failed');
    },
  });

  ticker.start();
  logger.info({ intervalMs: config.heartbeatMs }, 'job loop started');

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
