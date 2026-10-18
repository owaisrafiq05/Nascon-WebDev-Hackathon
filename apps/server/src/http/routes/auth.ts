import { notFound } from '@ubmp/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { ServerConfig } from '../../config.js';
import { currentIdentity, login, signUp } from '../../services/auth-service.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../services/password.js';
import { issueSession, revokeSession } from '../../services/session-service.js';
import {
  authOf,
  readSessionCookie,
  requireSession,
  SESSION_COOKIE,
} from '../middleware/authenticate.js';
import { clearCsrfCookie, setCsrfCookie } from '../middleware/csrf.js';

/**
 * Sign up, sign in, sign out and identity (F1.1).
 *
 * Every input is parsed with Zod before it reaches a service (Q3). The password
 * rule is declared once, in `services/password.ts`, so the schema and the hasher
 * cannot disagree about what is acceptable.
 */

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${String(MIN_PASSWORD_LENGTH)} characters`)
  .max(MAX_PASSWORD_LENGTH, `must be at most ${String(MAX_PASSWORD_LENGTH)} characters`);

const signUpSchema = z.object({
  email: z.string().trim().email('is not a valid email address').max(320),
  password: passwordSchema,
  name: z.string().trim().min(1, 'is required').max(200),
  workspaceName: z.string().trim().min(1, 'is required').max(200),
});

const loginSchema = z.object({
  // Not validated as an email beyond being a non-empty string: a strict rule
  // here would answer "that is not an email" for an address the attacker could
  // then rule out, and the credentials are wrong either way.
  email: z.string().trim().min(1, 'is required').max(320),
  password: z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH),
});

export interface AuthRouterOptions {
  readonly config: ServerConfig;
  /** Applied to sign-in only, so a test can supply its own limiter. */
  readonly loginRateLimiter: RequestHandler;
}

export function createAuthRouter({ config, loginRateLimiter }: AuthRouterOptions): Router {
  const router = Router();

  /** The session cookie: httpOnly, Secure in production, SameSite=Lax (Q1). */
  const sessionCookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: config.sessionTtlMs,
  };

  router.post('/auth/signup', async (req, res) => {
    const input = signUpSchema.parse(req.body);

    const { userId, workspaceId, membershipId } = await signUp({
      ...input,
      requestId: req.id,
    });

    const session = await issueSession({
      userId,
      workspaceId,
      membershipId,
      ttlMs: config.sessionTtlMs,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions);
    setCsrfCookie(res, session.csrfToken, config.isProduction);

    const identity = await currentIdentity(userId, workspaceId, membershipId);
    res.status(201).json(identity);
  });

  router.post('/auth/login', loginRateLimiter, async (req, res) => {
    const input = loginSchema.parse(req.body);

    const { userId, workspaceId, membershipId } = await login(input);

    const session = await issueSession({
      userId,
      workspaceId,
      membershipId,
      ttlMs: config.sessionTtlMs,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions);
    setCsrfCookie(res, session.csrfToken, config.isProduction);

    const identity = await currentIdentity(userId, workspaceId, membershipId);
    res.status(200).json(identity);
  });

  /**
   * Signing out revokes the session server-side as well as clearing the cookie,
   * so a copied cookie is dead too (Q1).
   *
   * No session is not an error: the caller wanted to be signed out and is.
   */
  router.post('/auth/logout', async (req, res) => {
    const token = readSessionCookie(req);
    if (token !== undefined) await revokeSession(token);

    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions, maxAge: undefined });
    clearCsrfCookie(res, config.isProduction);

    res.status(204).send();
  });

  /**
   * Who the caller is. The web app calls this on load, which is what makes a
   * refresh keep the user signed in (F1.1).
   */
  router.get('/auth/me', requireSession(), async (req, res) => {
    const auth = authOf(req);

    const identity = await currentIdentity(auth.userId, auth.workspaceId, auth.membershipId);
    if (identity === null) throw notFound('That account is no longer available.');

    res.status(200).json(identity);
  });

  return router;
}
