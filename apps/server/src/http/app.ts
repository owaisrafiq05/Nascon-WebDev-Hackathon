import { forbidden } from '@ubmp/shared';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';

import type { ServerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { loadSession } from './middleware/authenticate.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { loginRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter } from './routes/health.js';
import { createMembersRouter } from './routes/members.js';
import { createOpportunitiesRouter } from './routes/opportunities.js';
import { createPermissionSetsRouter } from './routes/permission-sets.js';

export const API_PREFIX = '/api';

export interface CreateAppOptions {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly version: string;
  /**
   * Overridden by tests that need a limiter with its own threshold, or none.
   * Production always uses the configured one.
   */
  readonly loginRateLimiterOverride?: RequestHandler;
}

/**
 * Builds the Express application. Kept separate from `index.ts` so tests can
 * exercise the real middleware stack with supertest, without opening a port or
 * connecting to a database.
 *
 * Middleware order matters and is deliberate:
 *
 *   request id        correlates logs, errors and audit entries
 *   security headers  Helmet
 *   CORS              explicit allow-list
 *   cookies           parsed before any session can be read
 *   body parsing      with a size limit
 *   session           resolved from the cookie, if present
 *   CSRF              needs to know whether a session authenticated the request
 *   routes
 *   404 -> errors     one place where an error becomes a response
 */
export function createApp({
  config,
  logger,
  version,
  loginRateLimiterOverride,
}: CreateAppOptions): Express {
  const app = express();

  // Trust the first proxy hop only, so `req.ip` is the client address behind a
  // tunnel (ngrok, cloudflared) without letting a caller spoof it with a long
  // X-Forwarded-For chain. The login rate limiter keys on this.
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
      // Required for the session cookie to travel from the web app.
      credentials: true,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.jsonBodyLimit }));

  app.use(loadSession());
  app.use(csrfProtection());

  app.use(
    API_PREFIX,
    createHealthRouter({
      service: 'ubmp-server',
      version,
      environment: config.env,
    }),
  );

  app.use(
    API_PREFIX,
    createAuthRouter({
      config,
      loginRateLimiter: loginRateLimiterOverride ?? loginRateLimiter(config),
    }),
  );

  app.use(API_PREFIX, createMembersRouter(config));
  app.use(API_PREFIX, createPermissionSetsRouter());
  app.use(API_PREFIX, createOpportunitiesRouter());

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
