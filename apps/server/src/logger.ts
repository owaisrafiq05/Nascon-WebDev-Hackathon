import { pino, type Logger } from 'pino';

import type { ServerConfig } from './config.js';

/**
 * Redaction is configured centrally so that a credential cannot reach the log by
 * being added to a request somewhere (I5.3). Paths are added here as each
 * integration lands.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-twilio-signature"]',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.authToken',
  '*.secret',
];

export function createLogger(config: Pick<ServerConfig, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  });
}

export type { Logger };
