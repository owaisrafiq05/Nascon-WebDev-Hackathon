import { PERMISSIONS } from '@ubmp/domain';
import { offsetFor, paginate, paginationQuerySchema } from '@ubmp/shared';
import { Router } from 'express';
import { z } from 'zod';

import type { IntegrationsConfig } from '../../config.js';
import { ContactModel } from '../../db/models/contact.js';
import { ConversationModel } from '../../db/models/conversation.js';
import { MessageModel } from '../../db/models/message.js';
import { actorFor, findContact } from '../../services/crm-service.js';
import {
  canSeeAllConversations,
  conversationViews,
  findVisibleConversation,
  messageView,
  retryMessage,
  sendMessage,
  sendToContact,
} from '../../services/messaging-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/require-permission.js';
import { requireParam } from '../params.js';

/** Conversations and messages (I1.1 - I1.9). */
const bodySchema = z.object({ body: z.string().trim().min(1, 'is required').max(1_600) });

export function createMessagingRouter(config: IntegrationsConfig): Router {
  const router = Router();

  router.get(
    '/conversations',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const { mine } = z.object({ mine: z.enum(['true', 'false']).optional() }).parse(req.query);
      const auth = authOf(req);
      const filter: Record<string, unknown> = { workspaceId: auth.workspaceId };
      // Visible only to permitted users (I1.6).
      if (mine === 'true' || !canSeeAllConversations(auth)) {
        filter['assigneeMembershipId'] = auth.membershipId;
      }
      const [items, total] = await Promise.all([
        ConversationModel.find(filter)
          .sort({ lastMessageAt: -1, _id: -1 })
          .skip(offsetFor(pagination))
          .limit(pagination.limit)
          .lean(),
        ConversationModel.countDocuments(filter),
      ]);
      res
        .status(200)
        .json(paginate(await conversationViews(auth.workspaceId, items), pagination, total));
    },
  );

  router.get(
    '/conversations/:conversationId/messages',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_VIEW),
    async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const auth = authOf(req);
      const conversation = await findVisibleConversation(auth, requireParam(req, 'conversationId'));
      const filter = { workspaceId: auth.workspaceId, conversationId: conversation._id };

      // The newest page, shown oldest first.
      const [newestFirst, total] = await Promise.all([
        MessageModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(offsetFor(pagination))
          .limit(pagination.limit)
          .lean(),
        MessageModel.countDocuments(filter),
      ]);
      await ConversationModel.updateOne({ _id: conversation._id }, { $set: { unreadCount: 0 } });

      const [view] = await conversationViews(auth.workspaceId, [conversation]);
      res.status(200).json({
        conversation: view,
        ...paginate(newestFirst.reverse().map(messageView), pagination, total),
      });
    },
  );

  router.post(
    '/conversations/:conversationId/messages',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const { body } = bodySchema.parse(req.body);
      const auth = authOf(req);
      const conversation = await findVisibleConversation(auth, requireParam(req, 'conversationId'));
      const message = await sendMessage({
        auth,
        conversation,
        body,
        actor: await actorFor(auth),
        config,
      });
      res.status(201).json(messageView(message));
    },
  );

  router.post(
    '/contacts/:contactId/messages',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const { body } = bodySchema.parse(req.body);
      const auth = authOf(req);
      const result = await sendToContact({
        auth,
        contactId: requireParam(req, 'contactId'),
        body,
        actor: await actorFor(auth),
        config,
      });
      res.status(201).json({
        conversationId: result.conversation._id.toString(),
        message: messageView(result.message),
      });
    },
  );

  router.post(
    '/messages/:messageId/retry',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const message = await retryMessage(authOf(req), requireParam(req, 'messageId'), config);
      res.status(200).json(messageView(message));
    },
  );

  /** Opt-out (I1.9): recorded on the contact, enforced on every send. */
  router.post(
    '/contacts/:contactId/opt-out',
    requireSession(),
    requirePermission(PERMISSIONS.CRM_EDIT),
    async (req, res) => {
      const { optedOut } = z.object({ optedOut: z.boolean() }).parse(req.body);
      const auth = authOf(req);
      const contact = await findContact(auth, requireParam(req, 'contactId'));
      await ContactModel.updateOne(
        { _id: contact._id, workspaceId: auth.workspaceId },
        { $set: { optedOutOfMessaging: optedOut }, $inc: { version: 1 } },
      );
      res.status(200).json({ optedOut });
    },
  );

  return router;
}
