import { ERROR_CODES, AppError } from '@ubmp/shared';
import type { Request, RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import type { ServerConfig } from '../../config.js';

/**
 * Login attempt limiting (Q1): "login is protected against repeated guessing".
 *
 * Keyed on the IP **and** the submitted email, so one office behind a single
 * address cannot be locked out by a colleague's typo, while an attacker
 * spraying one address from one host is stopped. `ipKeyGenerator` is used rather
 * than `req.ip` directly, because it collapses an IPv6 address to its /56
 * prefix; keying on a bare IPv6 address would let an attacker with a routed
 * block get a fresh bucket per request.
 */
function loginKey(req: Request): string {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : 'unknown';

  return `${ipKeyGenerator(req.ip ?? '')}:${email}`;
}

export function loginRateLimiter(config: ServerConfig): RequestHandler {
  return rateLimit({
    windowMs: config.loginRateLimit.windowMs,
    limit: config.loginRateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: loginKey,
    // Only failures count. A member signing in successfully several times in a
    // row is not guessing, and counting those would lock out a shared office.
    skipSuccessfulRequests: true,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          ERROR_CODES.RATE_LIMITED,
          'Too many sign-in attempts. Please wait before trying again.',
          {
            hint: `Try again in ${String(Math.ceil(config.loginRateLimit.windowMs / 60_000))} minutes.`,
          },
        ),
      );
    },
  });
}
