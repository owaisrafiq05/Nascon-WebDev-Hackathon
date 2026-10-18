import { unauthenticated } from '@ubmp/shared';
import type { NextFunction, Request, Response } from 'express';

import { resolveSession, touchSession, type AuthContext } from '../../services/session-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Present once `requireSession` has run. `workspaceId` on it is the only
       * source of tenant scoping: it comes from the session, never from a URL or
       * a body (CLAUDE.md, F1.6).
       */
      auth?: AuthContext;
    }
  }
}

export const SESSION_COOKIE = 'ubmp.sid';
export const CSRF_COOKIE = 'ubmp.csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Reads the session cookie if there is one, without requiring it. Used so that
 * `/me` can answer "not signed in" rather than failing, and so the CSRF check
 * can tell a cookie-authenticated request from an anonymous one.
 */
export function loadSession() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = readSessionCookie(req);
    if (token === undefined) {
      next();
      return;
    }

    try {
      const auth = await resolveSession(token);
      if (auth !== null) req.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Rejects the request unless a valid session was loaded. */
export function requireSession() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.auth === undefined) {
      next(
        unauthenticated('You need to sign in to do that.', {
          hint: 'Sign in and try again.',
        }),
      );
      return;
    }

    // Fire-and-forget: the request must not wait on a bookkeeping write, and a
    // failure here has no bearing on whether the caller is authorised.
    void touchSession(req.auth.sessionId).catch(() => undefined);
    next();
  };
}

export function readSessionCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const value = cookies?.[SESSION_COOKIE];
  return value === undefined || value === '' ? undefined : value;
}

/** Narrowed accessor, so routes do not repeat the undefined check. */
export function authOf(req: Request): AuthContext {
  if (req.auth === undefined) {
    throw unauthenticated('You need to sign in to do that.');
  }
  return req.auth;
}
