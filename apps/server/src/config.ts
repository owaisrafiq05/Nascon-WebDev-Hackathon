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
/** An unset variable and an empty one (`KEY=` in .env) mean the same thing. */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

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

  /** Public lead form limiting, per IP (F3.1). */
  PUBLIC_FORM_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
  PUBLIC_FORM_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(10),

  /** How often the API relays outbox rows to sockets (Q11). */
  OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(500),

  /**
   * 32 bytes, base64, for AES-256-GCM encryption of provider tokens at rest.
   * Optional so a fresh clone runs; connecting an integration without it is
   * refused with a clear message.
   */
  ENCRYPTION_KEY: optionalString.refine(
    (value) => value === undefined || Buffer.from(value, 'base64').length === 32,
    'must be 32 bytes encoded as base64 (openssl rand -base64 32)',
  ),
  /** The HTTPS address providers call back on (ngrok or cloudflared). */
  PUBLIC_BASE_URL: optionalString.pipe(z.string().url().optional()),
  /** Where links in external alerts point. Defaults to the first web origin. */
  WEB_APP_URL: optionalString.pipe(z.string().url().optional()),

  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString,
  GOOGLE_OAUTH_REDIRECT_URI: optionalString.pipe(z.string().url().optional()),

  /** Read only by `pnpm seed`, to connect the demo workspace. */
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_WHATSAPP_FROM: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  TELEGRAM_BOT_TOKEN: optionalString,
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
  readonly publicFormRateLimit: {
    readonly max: number;
    readonly windowMs: number;
  };
  readonly outboxRelayIntervalMs: number;
  readonly integrations: IntegrationsConfig;
}

export interface IntegrationsConfig {
  /** `null` when ENCRYPTION_KEY is unset: connecting is then refused. */
  readonly encryptionKey: Buffer | null;
  /** `null` when unset: webhook URLs cannot be shown and Twilio cannot verify. */
  readonly publicBaseUrl: string | null;
  readonly webAppUrl: string;
  readonly google: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
  } | null;
  /** Credentials `pnpm seed` uses to connect the demo workspace, when present. */
  readonly demo: {
    readonly twilio: { accountSid: string; authToken: string; from: string } | null;
    readonly stripe: { secretKey: string; webhookSecret: string } | null;
    readonly telegramBotToken: string | null;
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
    publicFormRateLimit: {
      max: env.PUBLIC_FORM_RATE_LIMIT_MAX,
      windowMs: env.PUBLIC_FORM_RATE_LIMIT_WINDOW_MINUTES * 60 * 1_000,
    },
    outboxRelayIntervalMs: env.OUTBOX_RELAY_INTERVAL_MS,
    integrations: integrationsConfigFrom(env),
  };
}

export function integrationsConfigFrom(env: ServerEnv): IntegrationsConfig {
  const {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_OAUTH_REDIRECT_URI: redirectUri,
  } = env;

  return {
    encryptionKey:
      env.ENCRYPTION_KEY === undefined ? null : Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? null,
    webAppUrl: (env.WEB_APP_URL ?? env.WEB_ORIGINS[0] ?? 'http://localhost:5173').replace(
      /\/+$/,
      '',
    ),
    google:
      clientId === undefined || clientSecret === undefined || redirectUri === undefined
        ? null
        : { clientId, clientSecret, redirectUri },
    demo: {
      twilio:
        env.TWILIO_ACCOUNT_SID === undefined ||
        env.TWILIO_AUTH_TOKEN === undefined ||
        env.TWILIO_WHATSAPP_FROM === undefined
          ? null
          : {
              accountSid: env.TWILIO_ACCOUNT_SID,
              authToken: env.TWILIO_AUTH_TOKEN,
              from: env.TWILIO_WHATSAPP_FROM,
            },
      stripe:
        env.STRIPE_SECRET_KEY === undefined || env.STRIPE_WEBHOOK_SECRET === undefined
          ? null
          : { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET },
      telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? null,
    },
  };
}

/**
 * The integrations slice alone, for the worker: it sends notifications and
 * refreshes nothing else, so it does not need the HTTP settings.
 */
export function loadIntegrationsConfig(
  source: Record<string, string | undefined> = process.env,
): IntegrationsConfig {
  const env = loadEnv('server', serverEnvSchema, source);
  return integrationsConfigFrom(env);
}
