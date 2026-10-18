import { ASSIGNABLE_PERMISSIONS, PERMISSIONS } from '@ubmp/domain';
import { Router } from 'express';
import { z } from 'zod';

import {
  createPermissionSet,
  deletePermissionSet,
  listPermissionSets,
  updatePermissionSet,
} from '../../services/permission-set-service.js';
import { requireParam } from '../params.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';

/**
 * The workspace's permission sets (F1.3).
 *
 * The catalogue of grantable permissions is served alongside them, so the matrix
 * editor renders exactly what the server will accept and cannot offer a
 * permission that would be refused.
 */
const createSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(100),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.string().max(100)).max(50),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    permissions: z.array(z.string().max(100)).max(50).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'provide at least one field' });

export function createPermissionSetsRouter(): Router {
  const router = Router();

  // Readable by anyone with member management, because the Team page shows which
  // set each member holds.
  router.get(
    '/permission-sets',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      const sets = await listPermissionSets(authOf(req).workspaceId);

      res.status(200).json({ permissionSets: sets, assignablePermissions: ASSIGNABLE_PERMISSIONS });
    },
  );

  router.post(
    '/permission-sets',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      const input = createSchema.parse(req.body);

      const result = await createPermissionSet(authOf(req), input, req.id);

      res.status(201).json(result);
    },
  );

  router.patch(
    '/permission-sets/:setId',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      const input = updateSchema.parse(req.body);

      await updatePermissionSet(authOf(req), requireParam(req, 'setId'), input, req.id);

      res.status(204).send();
    },
  );

  router.delete(
    '/permission-sets/:setId',
    requireSession(),
    requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    async (req, res) => {
      await deletePermissionSet(authOf(req), requireParam(req, 'setId'), req.id);

      res.status(204).send();
    },
  );

  return router;
}
