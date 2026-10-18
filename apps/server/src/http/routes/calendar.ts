import { PERMISSIONS } from '@ubmp/domain';
import { offsetFor, paginate, paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import type { IntegrationsConfig } from '../../config.js';
import { AppointmentModel } from '../../db/models/appointment.js';
import {
  appointmentViews,
  authorizationUrl,
  bookableEmployees,
  bookAppointment,
  busyTimes,
  cancelAppointment,
  completeConnection,
  connectionStatus,
  disconnectCalendar,
  rescheduleAppointment,
} from '../../services/calendar-service.js';
import { actorFor } from '../../services/crm-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';

/** Google Calendar connections and appointments (I3.1 - I3.7). */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'is not a valid id');
const isoDate = z.string().datetime({ offset: true, message: 'must be an ISO 8601 time' });

export function createCalendarRouter(config: IntegrationsConfig): Router {
  const router = Router();

  router.get('/calendar/connection', requireSession(), async (req, res) => {
    res.status(200).json(await connectionStatus(authOf(req), config));
  });

  router.post('/calendar/connect', requireSession(), (req, res) => {
    res.status(200).json({ authorizationUrl: authorizationUrl(authOf(req), config) });
  });

  /**
   * Google redirects the browser here. It is a top-level GET, so the
   * SameSite=Lax session cookie travels with it, and the state must belong to
   * that same member.
   */
  router.get('/integrations/google/callback', async (req, res) => {
    const back = (outcome: string, reason?: string): void => {
      const query = new URLSearchParams({
        calendar: outcome,
        ...(reason === undefined ? {} : { reason }),
      });
      res.redirect(302, `${config.webAppUrl}/settings?${query.toString()}`);
    };
    if (req.auth === undefined) {
      back('error', 'Sign in first, then connect your calendar again.');
      return;
    }
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      })
      .parse(req.query);
    if (query.error !== undefined || query.code === undefined || query.state === undefined) {
      back(
        'error',
        query.error === 'access_denied'
          ? 'You declined the Google consent.'
          : 'Google did not complete the consent.',
      );
      return;
    }
    try {
      await completeConnection({
        auth: req.auth,
        code: query.code,
        state: query.state,
        actor: await actorFor(req.auth),
        config,
      });
      back('connected');
    } catch (error) {
      back('error', error instanceof Error ? error.message : 'The connection failed.');
    }
  });

  router.delete('/calendar/connection', requireSession(), async (req, res) => {
    const auth = authOf(req);
    await disconnectCalendar(auth, await actorFor(auth), config);
    res.status(204).send();
  });

  router.get(
    '/calendar/employees',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      res.status(200).json({ items: await bookableEmployees(authOf(req)) });
    },
  );

  router.get(
    '/calendar/busy',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const query = z
        .object({ membershipId: objectId, from: isoDate, to: isoDate })
        .refine((value) => new Date(value.to) > new Date(value.from), {
          message: 'to must be after from',
        })
        .parse(req.query);
      const result = await busyTimes(
        authOf(req),
        query.membershipId,
        new Date(query.from),
        new Date(query.to),
        config,
      );
      res.status(200).json({
        busy: result.busy.map((entry) => ({
          start: entry.start.toISOString(),
          end: entry.end.toISOString(),
        })),
        timeZone: result.timeZone,
      });
    },
  );

  router.post(
    '/appointments',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const input = z
        .object({
          contactId: objectId,
          opportunityId: objectId.optional(),
          employeeMembershipId: objectId,
          title: z.string().trim().min(1, 'is required').max(200),
          notes: z.string().trim().max(2_000).optional(),
          startsAt: isoDate,
          endsAt: isoDate,
          timeZone: z.string().trim().min(1).max(64),
          allowOverlap: z.boolean().default(false),
        })
        .parse(req.body);
      const auth = authOf(req);
      const appointment = await bookAppointment({
        auth,
        contactId: input.contactId,
        opportunityId: input.opportunityId,
        employeeMembershipId: input.employeeMembershipId,
        title: input.title,
        notes: input.notes,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        timeZone: input.timeZone,
        allowOverlap: input.allowOverlap,
        actor: await actorFor(auth),
        config,
      });
      const [view] = await appointmentViews(auth.workspaceId, [appointment]);
      res.status(201).json(view);
    },
  );

  router.get(
    '/appointments',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const query = z
        .object({
          contactId: objectId.optional(),
          opportunityId: objectId.optional(),
          employeeMembershipId: objectId.optional(),
          upcoming: z.enum(['true', 'false']).optional(),
          status: z.enum(['scheduled', 'cancelled']).optional(),
        })
        .parse(req.query);
      const auth = authOf(req);
      const filter: Record<string, unknown> = { workspaceId: auth.workspaceId };
      if (query.contactId !== undefined) filter['contactId'] = new Types.ObjectId(query.contactId);
      if (query.opportunityId !== undefined)
        filter['opportunityId'] = new Types.ObjectId(query.opportunityId);
      if (query.employeeMembershipId !== undefined) {
        filter['employeeMembershipId'] = new Types.ObjectId(query.employeeMembershipId);
      }
      if (query.status !== undefined) filter['status'] = query.status;
      const upcoming = query.upcoming === 'true';
      if (upcoming) {
        // The same definition the dashboard tile counts (Q12).
        filter['status'] = 'scheduled';
        filter['startsAt'] = { $gte: new Date() };
      }

      const [items, total] = await Promise.all([
        AppointmentModel.find(filter)
          .sort({ startsAt: upcoming ? 1 : -1 })
          .skip(offsetFor(pagination))
          .limit(pagination.limit)
          .lean(),
        AppointmentModel.countDocuments(filter),
      ]);
      res
        .status(200)
        .json(paginate(await appointmentViews(auth.workspaceId, items), pagination, total));
    },
  );

  router.patch(
    '/appointments/:appointmentId',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const input = z
        .object({
          startsAt: isoDate,
          endsAt: isoDate,
          timeZone: z.string().trim().min(1).max(64),
          title: z.string().trim().min(1).max(200).optional(),
          notes: z.string().trim().max(2_000).optional(),
          version: z.number().int().min(0),
          allowOverlap: z.boolean().default(false),
        })
        .parse(req.body);
      const auth = authOf(req);
      const appointment = await rescheduleAppointment({
        auth,
        appointmentId: requireParam(req, 'appointmentId'),
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        timeZone: input.timeZone,
        title: input.title,
        notes: input.notes,
        version: input.version,
        allowOverlap: input.allowOverlap,
        actor: await actorFor(auth),
        config,
      });
      const [view] = await appointmentViews(auth.workspaceId, [appointment]);
      res.status(200).json(view);
    },
  );

  router.post(
    '/appointments/:appointmentId/cancel',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const auth = authOf(req);
      const appointment = await cancelAppointment({
        auth,
        appointmentId: requireParam(req, 'appointmentId'),
        actor: await actorFor(auth),
        config,
      });
      const [view] = await appointmentViews(auth.workspaceId, [appointment]);
      res.status(200).json(view);
    },
  );

  return router;
}
