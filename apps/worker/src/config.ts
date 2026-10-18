import { loadEnv, logLevelSchema, mongoUriSchema, nodeEnvSchema } from '@ubmp/shared';
import { z } from 'zod';

/**
 * The worker's configuration. It shares the database with the server but is a
 * separate process with its own validated environment, so it can be run and
 * restarted independently (Q5).
 */
const workerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  MONGODB_URI: mongoUriSchema,
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
});

export interface WorkerConfig {
  readonly env: z.infer<typeof nodeEnvSchema>;
  readonly logLevel: z.infer<typeof logLevelSchema>;
  readonly mongoUri: string;
  readonly heartbeatMs: number;
}

export function loadWorkerConfig(
  source: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const env = loadEnv('worker', workerEnvSchema, source);

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    mongoUri: env.MONGODB_URI,
    heartbeatMs: env.WORKER_HEARTBEAT_MS,
  };
}
