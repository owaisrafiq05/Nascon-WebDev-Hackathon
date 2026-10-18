import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';
import { toQueryString } from '../../lib/query-string.js';
import { paged, pageInfoSchema } from '../../lib/schemas.js';

/** Conversations and messages over WhatsApp / SMS (I1). */
export const conversationSchema = z.object({
  id: z.string(),
  contactId: z.string().nullish(),
  contactName: z.string().nullish(),
  channel: z.string().nullish(),
  address: z.string().nullish(),
  assigneeMembershipId: z.string().nullish(),
  assigneeEmail: z.string().nullish(),
  lastMessageAt: z.string().nullish(),
  lastMessagePreview: z.string().nullish(),
  optedOut: z.boolean().nullish(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string().nullish(),
  direction: z.string(),
  body: z.string(),
  status: z.string(),
  failureReason: z.string().nullish(),
  failureCode: z.string().nullish(),
  attempts: z.number().nullish(),
  sentByMembershipId: z.string().nullish(),
  createdAt: z.string().nullish(),
  statusUpdatedAt: z.string().nullish(),
});

export type Message = z.infer<typeof messageSchema>;

const threadSchema = z.object({
  conversation: conversationSchema,
  items: z.array(messageSchema),
  pageInfo: pageInfoSchema,
});

export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
  undelivered: 'Not delivered',
};

export function useConversations(query: { mine: boolean; page: number }) {
  return useQuery({
    queryKey: ['conversations', query],
    queryFn: () =>
      apiRequest(
        `/api/conversations?${toQueryString({ mine: query.mine ? 'true' : 'false', page: query.page })}`,
        paged(conversationSchema),
      ),
  });
}

export function useThread(conversationId: string, page: number) {
  return useQuery({
    queryKey: ['messages', conversationId, page],
    queryFn: () =>
      apiRequest(
        `/api/conversations/${conversationId}/messages?${toQueryString({ page, limit: 100 })}`,
        threadSchema,
      ),
  });
}

function useMessagingMutation<TValues, TResult>(mutationFn: (values: TValues) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of ['conversations', 'messages', 'contact-view']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useSendReply(conversationId: string) {
  return useMessagingMutation((body: string) =>
    apiRequest(`/api/conversations/${conversationId}/messages`, messageSchema, {
      method: 'POST',
      body: { body },
    }),
  );
}

export function useRetryMessage() {
  return useMessagingMutation((messageId: string) =>
    apiRequest(`/api/messages/${messageId}/retry`, messageSchema, { method: 'POST' }),
  );
}

export function useSendToContact(contactId: string) {
  return useMessagingMutation((body: string) =>
    apiRequest(
      `/api/contacts/${contactId}/messages`,
      z.object({ conversationId: z.string(), message: messageSchema }),
      { method: 'POST', body: { body } },
    ),
  );
}

export function useSetOptOut(contactId: string) {
  return useMessagingMutation((optedOut: boolean) =>
    apiRequest(`/api/contacts/${contactId}/opt-out`, z.object({ optedOut: z.boolean() }), {
      method: 'POST',
      body: { optedOut },
    }),
  );
}
