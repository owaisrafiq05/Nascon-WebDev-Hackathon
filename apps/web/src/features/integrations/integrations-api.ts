import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';
import { toQueryString } from '../../lib/query-string.js';
import { paged } from '../../lib/schemas.js';

/** The integrations hub (I5): status, limits, secrets (hints only), sync history. */
const recentErrorSchema = z.object({
  at: z.string().nullish(),
  kind: z.string().nullish(),
  result: z.string().nullish(),
  error: z.string().nullish(),
});

export const integrationSchema = z.object({
  provider: z.string(),
  name: z.string(),
  can: z.array(z.string()).default([]),
  cannot: z.array(z.string()).default([]),
  scope: z.string().nullish(),
  status: z.string(),
  lastSuccessAt: z.string().nullish(),
  lastErrorAt: z.string().nullish(),
  lastError: z.string().nullish(),
  secretHints: z.record(z.string(), z.string()).nullish(),
  publicConfig: z.record(z.string(), z.string()).nullish(),
  webhookUrls: z.record(z.string(), z.string().nullable()).nullish(),
  recentErrors: z.array(recentErrorSchema).default([]),
  fields: z
    .object({ secrets: z.array(z.string()).default([]), public: z.array(z.string()).default([]) })
    .nullish(),
  configured: z.boolean().nullish(),
  connectedEmployees: z.number().nullish(),
  needsReconnect: z.number().nullish(),
});

export type Integration = z.infer<typeof integrationSchema>;

const eventSchema = z.object({
  id: z.string(),
  provider: z.string(),
  direction: z.string().nullish(),
  kind: z.string().nullish(),
  result: z.string(),
  reference: z.string().nullish(),
  httpStatus: z.number().nullish(),
  error: z.string().nullish(),
  transient: z.boolean().nullish(),
  createdAt: z.string().nullish(),
});

const notificationSchema = z.object({
  id: z.string(),
  memberEmail: z.string().nullish(),
  leadId: z.string().nullish(),
  status: z.string(),
  attempts: z.number().nullish(),
  lastError: z.string().nullish(),
  sentAt: z.string().nullish(),
  createdAt: z.string().nullish(),
  text: z.string().nullish(),
});

export function useIntegrations() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: () =>
      apiRequest('/api/integrations', z.object({ integrations: z.array(integrationSchema) })),
  });
}

export function useIntegrationEvents(query: { provider: string; page: number }) {
  return useQuery({
    queryKey: ['integration-events', query],
    queryFn: () =>
      apiRequest(
        `/api/integrations/events?${toQueryString({ provider: query.provider, page: query.page })}`,
        paged(eventSchema),
      ),
  });
}

export function useFailedNotifications(page: number) {
  return useQuery({
    queryKey: ['notifications', 'failed', page],
    queryFn: () =>
      apiRequest(
        `/api/notifications?${toQueryString({ status: 'failed', page })}`,
        paged(notificationSchema),
      ),
  });
}

export function useSaveIntegration(provider: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, string>) =>
      apiRequest(`/api/integrations/${provider}`, z.unknown(), { method: 'PUT', body: values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

export function useDisconnectIntegration(provider: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest(`/api/integrations/${provider}`, z.unknown(), { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}
