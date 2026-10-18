import { forbidden } from '@ubmp/shared';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import type { ServerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestId } from './middleware/request-id.js';
import { createHealthRouter } from './routes/health.js';

export const API_PREFIX = '/api';

export interface CreateAppOptions {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly version: string;
}

/**
 * Builds the Express application. Kept separate from `index.ts` so tests can
 * exercise the real middleware stack with supertest, without opening a port or
 * connecting to a database.
 *
 * Middleware order matters and is deliberate:
 *   request id -> security headers -> CORS -> body parsing -> routes -> 404 -> errors
 */
export function createApp({ config, logger, version }: CreateAppOptions): Express {
  const app = express();

  // Trust the first proxy hop only, so `req.ip` is the client address behind a
  // tunnel (ngrok, cloudflared) without letting a caller spoof it with a long
  // X-Forwarded-For chain. This is what rate limiting will key on in P2.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId());
  app.use(helmet());

  app.use(
    cors({
      // An explicit allow-list (Q3). Requests with no Origin (server-to-server,
      // curl, provider webhooks) are allowed through; those routes are protected
      // by signature verification rather than by CORS.
      origin: (origin, callback) => {
        if (origin === undefined || config.webOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(forbidden(`Origin ${origin} is not allowed.`));
      },
      credentials: true,
    }),
  );

  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.jsonBodyLimit }));

  app.use(
    API_PREFIX,
    createHealthRouter({
      service: 'ubmp-server',
      version,
      environment: config.env,
    }),
  );

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
