import { pino, type Logger } from 'pino';

import type { WorkerConfig } from './config.js';

export function createLogger(config: Pick<WorkerConfig, 'logLevel'>): Logger {
  return pino({
    name: 'ubmp-worker',
    level: config.logLevel,
    redact: {
      paths: ['*.accessToken', '*.refreshToken', '*.apiKey', '*.authToken', '*.secret'],
      censor: '[redacted]',
    },
  });
}

export type { Logger };
