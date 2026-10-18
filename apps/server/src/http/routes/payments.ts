import { PERMISSIONS } from '@ubmp/domain';
import {
  AppError,
  ERROR_CODES,
  notFound,
  offsetFor,
  paginate,
  paginationQuerySchema,
} from '@ubmp/shared';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import type { IntegrationsConfig } from '../../config.js';
import { PaymentModel } from '../../db/models/payment.js';
import { actorFor } from '../../services/crm-service.js';
import { sendToContact } from '../../services/messaging-service.js';
import {
  assertPositiveAmount,
  formatMoney,
  paymentSummary,
  paymentViews,
  requestPayment,
} from '../../services/payment-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';

/** Payment requests and their status (I2.1 - I2.7). */
export function createPaymentsRouter(config: IntegrationsConfig): Router {
  const router = Router();

  router.post(
    '/opportunities/:opportunityId/payments',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const input = z
        .object({
          amount: z
            .number()
            .int('must be a whole number of minor units (cents)')
            .min(50)
            .max(99_999_999),
          currency: z
            .string()
            .trim()
            .regex(/^[A-Za-z]{3}$/, 'must be a 3-letter currency code'),
          description: z.string().trim().max(200).optional(),
        })
        .parse(req.body);
      assertPositiveAmount(input.amount);
      const auth = authOf(req);
      const payment = await requestPayment({
        auth,
        opportunityId: requireParam(req, 'opportunityId'),
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        actor: await actorFor(auth),
        config,
      });
      const [view] = await paymentViews(auth.workspaceId, [payment]);
      res.status(201).json(view);
    },
  );

  router.get(
    '/opportunities/:opportunityId/payments',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const opportunityId = requireParam(req, 'opportunityId');
      if (!Types.ObjectId.isValid(opportunityId))
        throw notFound('That opportunity does not exist.');
      const auth = authOf(req);
      const items = await PaymentModel.find({
        workspaceId: auth.workspaceId,
        opportunityId: new Types.ObjectId(opportunityId),
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      res.status(200).json({ items: await paymentViews(auth.workspaceId, items) });
    },
  );

  router.get(
    '/payments',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const query = z
        .object({
          status: z.enum(['pending', 'paid', 'expired', 'failed', 'refunded']).optional(),
          paidFrom: z.string().datetime({ offset: true }).optional(),
          contactId: z
            .string()
            .regex(/^[0-9a-fA-F]{24}$/)
            .optional(),
          mine: z.enum(['true', 'false']).optional(),
        })
        .parse(req.query);
      const auth = authOf(req);
      const filter: Record<string, unknown> = { workspaceId: auth.workspaceId };
      if (query.status !== undefined) filter['status'] = query.status;
      if (query.contactId !== undefined) filter['contactId'] = new Types.ObjectId(query.contactId);
      if (query.mine === 'true') filter['requestedByMembershipId'] = auth.membershipId;
      if (query.paidFrom !== undefined) {
        // The dashboard's "payments received" definition (I2.6, Q12).
        filter['paidAt'] = { $gte: new Date(query.paidFrom) };
        filter['confirmedByWebhook'] = true;
        filter['status'] = query.status ?? { $in: ['paid', 'refunded'] };
      }
      const [items, total] = await Promise.all([
        PaymentModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(offsetFor(pagination))
          .limit(pagination.limit)
          .lean(),
        PaymentModel.countDocuments(filter),
      ]);
      res
        .status(200)
        .json(paginate(await paymentViews(auth.workspaceId, items), pagination, total));
    },
  );

  router.get(
    '/payments/summary',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      res.status(200).json(await paymentSummary(authOf(req)));
    },
  );

  /** Sends the hosted payment link to the customer over messaging (I2.1). */
  router.post(
    '/payments/:paymentId/send',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const paymentId = requireParam(req, 'paymentId');
      if (!Types.ObjectId.isValid(paymentId)) throw notFound('That payment does not exist.');
      const auth = authOf(req);
      const payment = await PaymentModel.findOne({
        _id: new Types.ObjectId(paymentId),
        workspaceId: auth.workspaceId,
      }).lean();
      if (payment === null) throw notFound('That payment does not exist.');
      if (payment.status !== 'pending' || payment.checkoutUrl === null) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Only a pending payment link can be sent.');
      }
      if (payment.contactId === null) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'This opportunity has no contact to send the link to.',
        );
      }
      const result = await sendToContact({
        auth,
        contactId: payment.contactId.toString(),
        body: `Payment request: ${payment.description} — ${formatMoney(payment.amount, payment.currency)}. Pay securely here: ${payment.checkoutUrl}`,
        actor: await actorFor(auth),
        config,
      });
      if (result.message.status === 'failed') {
        throw new AppError(
          ERROR_CODES.UPSTREAM_FAILED,
          `The link could not be sent: ${result.message.failureReason ?? 'unknown reason'}`,
          {
            hint: 'Open the conversation to retry, or copy the link and send it another way.',
          },
        );
      }
      res.status(200).json({ sent: true, messageId: result.message._id.toString() });
    },
  );

  return router;
}
