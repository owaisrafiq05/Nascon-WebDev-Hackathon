import { BASE_LEVELS, PERMISSIONS } from '@ubmp/domain';
import { Router } from 'express';
import { z } from 'zod';

import type { ServerConfig } from '../../config.js';
import {
  acceptInvite,
  changeBaseLevel,
  changePermissions,
  inviteMember,
  listMembers,
  listPendingInvites,
  removeMember,
} from '../../services/membership-service.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../services/password.js';
import { requireParam } from '../params.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';

/**
 * The Team page's API (F1.2, F1.3).
 *
 * Reading the member list needs a session but no special permission: everyone
 * needs to know who their colleagues are. Changing anything needs
 * `members.manage`, and the service applies `canManageMembership` again on top,
 * so the Admin-cannot-touch-Owner rule holds even if a future route forgets the
 * middleware (F1.5).
 */

const baseLevelSchema = z.enum(BASE_LEVELS);
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'is not a valid id');

const inviteSchema = z.object({
  email: z.string().trim().email('is not a valid email address').max(320),
  baseLevel: baseLevelSchema,
  permissionSetIds: z.array(objectIdSchema).max(20).optional(),
});

const acceptSchema = z.object({
  token: z.string().min(1, 'is required').max(200),
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH).optional(),
});

const changeLevelSchema = z.object({ baseLevel: baseLevelSchema });

const changePermissionsSchema = z
  .object({
    permissionSetIds: z.array(objectIdSchema).max(20).optional(),
    extraPermissions: z.array(z.string().max(100)).max(50).optional(),
  })
  .refine((value) => value.permissionSetIds !== undefined || value.extraPermissions !== undefined, {
    message: 'provide permissionSetIds or extraPermissions',
  });

export function createMembersRouter(config: ServerConfig): Router {
  const router = Router();

  router.get('/members', requireSession(), async (req, res) => {
    const auth = authOf(req);
    const [members, invites] = await Promise.all([
      listMembers(auth.workspaceId),
      listPendingInvites(auth.workspaceId),
    ]);

    res.status(200).json({ members, pendingInvites: invites });
  });

  router.post(
    '/members/invites',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      const input = inviteSchema.parse(req.body);
      const auth = authOf(req);

      const result = await inviteMember(auth, {
        ...input,
        ttlMs: config.inviteTtlMs,
        requestId: req.id,
      });

      res.status(201).json(result);
    },
  );

  /**
   * Accepting an invitation is deliberately unauthenticated: the invitee has no
   * session yet, and the token in the link is what authorises them.
   */
  router.post('/members/invites/accept', async (req, res) => {
    const input = acceptSchema.parse(req.body);

    await acceptInvite({ ...input, requestId: req.id });

    // No session is issued here. The invitee signs in with the password they
    // just set, which keeps one path for establishing a session.
    res.status(204).send();
  });

  router.patch(
    '/members/:membershipId/level',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      const { baseLevel } = changeLevelSchema.parse(req.body);

      await changeBaseLevel(authOf(req), requireParam(req, 'membershipId'), baseLevel, req.id);

      res.status(204).send();
    },
  );

  /**
   * The permission matrix editor. `members.manage` gets past the middleware, and
   * the service then refuses anyone who is not an Owner, which is the rule that
   * actually matters here (F1.3).
   */
  router.patch(
    '/members/:membershipId/permissions',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      const input = changePermissionsSchema.parse(req.body);

      await changePermissions(authOf(req), requireParam(req, 'membershipId'), input, req.id);

      res.status(204).send();
    },
  );

  router.delete(
    '/members/:membershipId',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      await removeMember(authOf(req), requireParam(req, 'membershipId'), req.id);

      res.status(204).send();
    },
  );

  return router;
}
