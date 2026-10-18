import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';
import { toQueryString } from '../../lib/query-string.js';
import { paged } from '../../lib/schemas.js';

/** Payment requests and the revenue summary (I2). */
export const paymentSchema = z.object({
  id: z.string(),
  opportunityId: z.string().nullish(),
  opportunityName: z.string().nullish(),
  contactId: z.string().nullish(),
  contactName: z.string().nullish(),
  requestedByEmail: z.string().nullish(),
  amount: z.number(),
  currency: z.string(),
  description: z.string().nullish(),
  status: z.string(),
  confirmedByWebhook: z.boolean().nullish(),
  refundedAmount: z.number().nullish(),
  providerReference: z.string().nullish(),
  checkoutUrl: z.string().nullish(),
  failureReason: z.string().nullish(),
  paidAt: z.string().nullish(),
  expiresAt: z.string().nullish(),
  createdAt: z.string().nullish(),
});

export type Payment = z.infer<typeof paymentSchema>;

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  expired: 'Expired',
  failed: 'Failed',
  refunded: 'Refunded',
};

const summarySchema = z.object({
  currency: z.string(),
  collected: z.object({
    gross: z.number(),
    refunded: z.number(),
    net: z.number(),
    paymentCount: z.number(),
  }),
  projected: z.object({
    openOpportunities: z.number().nullish(),
    unpaidRequests: z.number().nullish(),
    total: z.number(),
  }),
});

export function usePayments(query: {
  status: string;
  paidFrom: string;
  mine: string;
  page: number;
}) {
  return useQuery({
    queryKey: ['payments', 'list', query],
    queryFn: () =>
      apiRequest(
        `/api/payments?${toQueryString({ status: query.status, paidFrom: query.paidFrom, mine: query.mine, page: query.page })}`,
        paged(paymentSchema),
      ),
  });
}

export function usePaymentSummary() {
  return useQuery({
    queryKey: ['payments', 'summary'],
    queryFn: () => apiRequest('/api/payments/summary', summarySchema),
  });
}

export function useOpportunityPayments(opportunityId: string) {
  return useQuery({
    queryKey: ['payments', 'opportunity', opportunityId],
    queryFn: () =>
      apiRequest(
        `/api/opportunities/${opportunityId}/payments`,
        z.object({ items: z.array(paymentSchema) }),
      ),
  });
}

export function useRequestPayment(opportunityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: { amount: number; currency: string; description?: string }) =>
      apiRequest(`/api/opportunities/${opportunityId}/payments`, paymentSchema, {
        method: 'POST',
        body: values,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['contact-view'] });
    },
  });
}

export function useSendPaymentLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) =>
      apiRequest(
        `/api/payments/${paymentId}/send`,
        z.object({ sent: z.boolean(), messageId: z.string().nullish() }),
        { method: 'POST' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}
