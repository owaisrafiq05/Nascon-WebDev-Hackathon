import {
  commaSeparatedList,
  loadEnv,
  logLevelSchema,
  mongoUriSchema,
  nodeEnvSchema,
} from '@ubmp/shared';
import { z } from 'zod';

/**
 * The server's configuration surface. Nothing outside this file reads
 * `process.env`, so every setting is validated once and typed from then on (Q13).
 *
 * Variables belonging to later phases (SESSION_SECRET, provider credentials) are
 * listed in .env.example but are not validated here until the phase that uses
 * them, so the scaffold runs from a fresh clone with no secrets at all.
 */
const serverEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  MONGODB_URI: mongoUriSchema,
  WEB_ORIGINS: commaSeparatedList,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export interface ServerConfig {
  readonly env: ServerEnv['NODE_ENV'];
  readonly isProduction: boolean;
  readonly logLevel: ServerEnv['LOG_LEVEL'];
  readonly port: number;
  readonly mongoUri: string;
  /** CORS allow-list. Requests from any other origin are refused (Q3). */
  readonly webOrigins: readonly string[];
  /** Maximum JSON body size. Raw webhook bodies get their own limit per route. */
  readonly jsonBodyLimit: string;
}

export function loadServerConfig(
  source: Record<string, string | undefined> = process.env,
): ServerConfig {
  const env = loadEnv('server', serverEnvSchema, source);

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    mongoUri: env.MONGODB_URI,
    webOrigins: env.WEB_ORIGINS,
    jsonBodyLimit: '1mb',
  };
}
