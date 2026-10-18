import { forbidden } from '@ubmp/shared';
import type { NextFunction, Request, Response } from 'express';

import { csrfTokenMatches } from '../../services/session-service.js';
import { CSRF_COOKIE, CSRF_HEADER } from './authenticate.js';

/**
 * CSRF protection for cookie-authenticated state-changing requests (Q3).
 *
 * A synchroniser token, not a bare double-submit: the expected value lives in
 * the session document on the server, so an attacker who can set cookies on the
 * victim's browser still cannot make the header and the server's copy agree.
 *
 * It applies only when a session cookie actually authenticated the request.
 * Sign-in and sign-up have no session to protect, and provider webhooks are not
 * cookie-authenticated at all: those are verified by provider signature instead
 * (I1.2, I2.3).
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    // No session means nothing to forge on the user's behalf.
    if (req.auth === undefined) {
      next();
      return;
    }

    const supplied = req.get(CSRF_HEADER);
    if (supplied === undefined || supplied === '') {
      next(
        forbidden('That request was missing its security token.', {
          hint: 'Reload the page and try again.',
        }),
      );
      return;
    }

    if (!csrfTokenMatches(req.auth.csrfToken, supplied)) {
      next(
        forbidden('That request carried an invalid security token.', {
          hint: 'Reload the page and try again.',
        }),
      );
      return;
    }

    next();
  };
}

/**
 * Publishes the session's CSRF token in a readable cookie so the web app can
 * echo it back in the header. The token is not a secret from the page: it only
 * has to be unavailable to *another* origin, which the same-origin policy
 * guarantees for cookie reads.
 */
export function setCsrfCookie(res: Response, token: string, isProduction: boolean): void {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}

export function clearCsrfCookie(res: Response, isProduction: boolean): void {
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}
