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
 * Provider credentials belonging to later phases are listed in .env.example but
 * are not validated here until the phase that uses them, so the server still
 * runs from a fresh clone with no secrets at all.
 *
 * There is deliberately no session signing secret: session tokens are 32 random
 * bytes and are stored only as a SHA-256 digest, so there is no key to manage
 * and a database leak yields no usable cookie. See docs/decisions.md.
 */
const serverEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  MONGODB_URI: mongoUriSchema,
  WEB_ORIGINS: commaSeparatedList,

  /** How long a session lasts before it expires and must be re-established (Q1). */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8_760).default(720),

  /** Login attempt limiting, per IP and email pair (Q1). */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000).default(5),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),

  /** How long an invitation stays usable before it must be re-sent. */
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(8_760).default(168),
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
  readonly sessionTtlMs: number;
  readonly inviteTtlMs: number;
  readonly loginRateLimit: {
    readonly max: number;
    readonly windowMs: number;
  };
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
    sessionTtlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1_000,
    inviteTtlMs: env.INVITE_TTL_HOURS * 60 * 60 * 1_000,
    loginRateLimit: {
      max: env.LOGIN_RATE_LIMIT_MAX,
      windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1_000,
    },
  };
}
