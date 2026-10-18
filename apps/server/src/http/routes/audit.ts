import { ALL_AUDIT_EVENT_TYPES, PERMISSIONS, type AuditEventType } from '@ubmp/domain';
import { paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { queryAuditEvents } from '../../repositories/audit-repository.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';

/**
 * The audit viewer (F4.2).
 *
 * This router mounts **only GET routes**. That is the second of the three guards
 * behind F4.3: there is no endpoint that could edit or remove an entry, the
 * repository exposes no mutating method, and the schema refuses non-insert
 * writes. A test asserts that every mutating verb on these paths is unroutable.
 */

const filterSchema = z.object({
  /** Comma-separated event types, as the viewer's checkboxes send them. */
  types: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ''
        ? undefined
        : value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
    ),
  /** Filter by the user who acted. */
  actorUserId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'is not a valid id')
    .optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export function createAuditRouter(): Router {
  const router = Router();

  router.get(
    '/audit-events',
    requireSession(),
    requirePermission(PERMISSIONS.AUDIT_LOG_VIEW),
    async (req, res) => {
      const filters = filterSchema.parse(req.query);
      const pagination = paginationQuerySchema.parse(req.query);
      const auth = authOf(req);

      // Unknown type names are dropped rather than refused: the viewer's filter
      // should not 422 because the catalogue changed under it.
      const types = filters.types
        ?.filter((type): type is AuditEventType =>
          (ALL_AUDIT_EVENT_TYPES as readonly string[]).includes(type),
        )
        .slice(0, 50);

      const page = await queryAuditEvents(
        {
          // From the session, never from the query string (F1.6).
          workspaceId: auth.workspaceId,
          ...(types === undefined || types.length === 0 ? {} : { types }),
          ...(filters.actorUserId === undefined
            ? {}
            : { actorUserId: new Types.ObjectId(filters.actorUserId) }),
          ...(filters.from === undefined ? {} : { from: new Date(filters.from) }),
          ...(filters.to === undefined ? {} : { to: new Date(filters.to) }),
        },
        pagination,
      );

      res.status(200).json({
        items: page.items.map((event) => ({
          id: event._id.toString(),
          type: event.type,
          at: event.at.toISOString(),
          actor: {
            kind: event.actorKind,
            userId: event.actorUserId?.toString() ?? null,
            label: event.actorLabel,
          },
          target: {
            kind: event.targetKind,
            id: event.targetId,
            label: event.targetLabel,
          },
          before: event.before,
          after: event.after,
        })),
        pageInfo: page.pageInfo,
      });
    },
  );

  /** The catalogue, so the viewer's type filter matches what can be stored. */
  router.get(
    '/audit-events/types',
    requireSession(),
    requirePermission(PERMISSIONS.AUDIT_LOG_VIEW),
    (_req, res) => {
      res.status(200).json({ types: ALL_AUDIT_EVENT_TYPES });
    },
  );

  return router;
}
