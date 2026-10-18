import { PERMISSIONS } from '@ubmp/domain';
import { offsetFor, paginate, paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';

import type { IntegrationsConfig } from '../../config.js';
import { INTEGRATION_PROVIDERS, IntegrationEventModel } from '../../db/models/integration-event.js';
import { IntegrationModel, WORKSPACE_PROVIDERS } from '../../db/models/integration.js';
import { MembershipModel } from '../../db/models/membership.js';
import { NOTIFICATION_STATUSES, NotificationModel } from '../../db/models/notification.js';
import { actorFor } from '../../services/crm-service.js';
import {
  connectIntegration,
  disconnectIntegration,
  listIntegrations,
} from '../../services/integration-service.js';
import { membershipLabels } from '../../services/lead-service.js';
import { notificationView, sendTestAlert } from '../../services/notification-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';

/**
 * The integrations page, connections, the synchronization history and failed
 * alerts (I5.1 - I5.7, I4.3, I4.4).
 */
const providerSchema = z.enum(WORKSPACE_PROVIDERS);

const credentialSchemas = {
  twilio: z.object({
    accountSid: z
      .string()
      .trim()
      .regex(/^AC[0-9a-fA-F]{32}$/, 'must look like AC followed by 32 hex characters')
      .optional(),
    authToken: z.string().trim().max(128).optional(),
    from: z
      .string()
      .trim()
      .regex(/^(whatsapp:)?\+\d{6,16}$/, 'must be +<number> or whatsapp:+<number>')
      .optional(),
  }),
  stripe: z.object({
    secretKey: z
      .string()
      .trim()
      .regex(/^(sk|rk)_test_\w+$/, 'must be a test-mode key (sk_test_…)')
      .optional(),
    webhookSecret: z
      .string()
      .trim()
      .regex(/^whsec_\w+$/, 'must start with whsec_')
      .optional(),
  }),
  telegram: z.object({
    botToken: z
      .string()
      .trim()
      .regex(/^\d+:[\w-]{20,}$/, 'must look like 123456:ABC…')
      .optional(),
  }),
} as const;

export function createIntegrationsRouter(config: IntegrationsConfig): Router {
  const router = Router();

  router.get(
    '/integrations',
    requireSession(),
    requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
    async (req, res) => {
      res.status(200).json(await listIntegrations(authOf(req).workspaceId, config));
    },
  );

  router.put(
    '/integrations/:provider',
    requireSession(),
    requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
    async (req, res) => {
      const provider = providerSchema.parse(requireParam(req, 'provider'));
      const values = credentialSchemas[provider].parse(req.body) as Record<
        string,
        string | undefined
      >;
      const auth = authOf(req);

      await connectIntegration({
        workspaceId: auth.workspaceId,
        provider,
        values: Object.fromEntries(
          Object.entries(values).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        actor: await actorFor(auth),
        config,
      });
      res.status(200).json({ connected: true });
    },
  );

  router.delete(
    '/integrations/:provider',
    requireSession(),
    requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
    async (req, res) => {
      const provider = providerSchema.parse(requireParam(req, 'provider'));
      const auth = authOf(req);
      await disconnectIntegration({
        workspaceId: auth.workspaceId,
        provider,
        actor: await actorFor(auth),
      });
      res.status(204).send();
    },
  );

  /** The synchronization history (I5.4). */
  router.get(
    '/integrations/events',
    requireSession(),
    requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const { provider, result } = z
        .object({
          provider: z.enum(INTEGRATION_PROVIDERS).optional(),
          result: z.enum(['ok', 'error', 'rejected', 'duplicate', 'ignored']).optional(),
        })
        .parse(req.query);
      const filter = {
        workspaceId: authOf(req).workspaceId,
        ...(provider === undefined ? {} : { provider }),
        ...(result === undefined ? {} : { result }),
      };
      const [items, total] = await Promise.all([
        IntegrationEventModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(offsetFor(pagination))
          .limit(pagination.limit)
          .lean(),
        IntegrationEventModel.countDocuments(filter),
      ]);
      res.status(200).json(
        paginate(
          items.map((event) => ({
            id: event._id.toString(),
            provider: event.provider,
            direction: event.direction,
            kind: event.kind,
            result: event.result,
            reference: event.reference,
            httpStatus: event.httpStatus,
            error: event.error,
            transient: event.transient,
            createdAt: event.createdAt.toISOString(),
          })),
          pagination,
          total,
        ),
      );
    },
  );

  /** Alerts, failed ones included, visible to Admins (I4.4). */
  router.get(
    '/notifications',
    requireSession(),
    requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const { status } = z
        .object({ status: z.enum(NOTIFICATION_STATUSES).optional() })
        .parse(req.query);
      const auth = authOf(req);
      const filter = { workspaceId: auth.workspaceId, ...(status === undefined ? {} : { status }) };
      const [items, total, labels] = await Promise.all([
        NotificationModel.find(filter)
          .sort({ createdAt: -1 })
          .skip(offsetFor(pagination))
          .limit(pagination.limit)
          .lean(),
        NotificationModel.countDocuments(filter),
        membershipLabels(auth.workspaceId),
      ]);
      res.status(200).json(
        paginate(
          items.map((item) =>
            notificationView(item, labels.get(item.membershipId.toString())?.email ?? null),
          ),
          pagination,
          total,
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Each employee's own alert destination (I4.3)
  // -------------------------------------------------------------------------

  const mySettings = async (workspaceId: Types.ObjectId, membershipId: Types.ObjectId) => {
    const [membership, telegram] = await Promise.all([
      MembershipModel.findOne({ _id: membershipId, workspaceId }).select('telegramChatId').lean(),
      IntegrationModel.findOne({
        workspaceId,
        provider: 'telegram',
        status: { $ne: 'disconnected' },
      })
        .select('publicConfig')
        .lean(),
    ]);
    return {
      telegramChatId: membership?.telegramChatId ?? null,
      telegramConnected: telegram !== null,
      botUsername: telegram?.publicConfig['botUsername'] ?? null,
    };
  };

  router.get('/me/notification-settings', requireSession(), async (req, res) => {
    const auth = authOf(req);
    res.status(200).json(await mySettings(auth.workspaceId, auth.membershipId));
  });

  router.put('/me/notification-settings', requireSession(), async (req, res) => {
    const { telegramChatId } = z
      .object({
        telegramChatId: z
          .string()
          .trim()
          .regex(/^-?\d{1,20}$/, 'must be a numeric Telegram chat id')
          .nullable(),
      })
      .parse(req.body);
    const auth = authOf(req);
    await MembershipModel.updateOne(
      { _id: auth.membershipId, workspaceId: auth.workspaceId },
      { $set: { telegramChatId } },
    );
    res.status(200).json(await mySettings(auth.workspaceId, auth.membershipId));
  });

  router.post('/me/notification-settings/test', requireSession(), async (req, res) => {
    const auth = authOf(req);
    await sendTestAlert(auth.workspaceId, auth.membershipId, config);
    res.status(200).json({ sent: true });
  });

  return router;
}
