import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';
import { toQueryString } from '../../lib/query-string.js';
import { paged } from '../../lib/schemas.js';

/** Leads, availability, recovery and assignment rules (F3.1 - F3.9). */

export const AVAILABILITY_STATUSES = ['available', 'busy', 'on_leave', 'offline'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const AVAILABILITY_LABELS: Record<string, string> = {
  available: 'Available',
  busy: 'Busy',
  on_leave: 'On leave',
  offline: 'Offline',
};

export const ESCALATION_TARGET_LABELS: Record<string, string> = {
  assignee: 'Same assignee',
  next_eligible: 'Next eligible employee',
  backup: 'Backup employee',
  manager: 'Manager',
};

export const leadSchema = z.object({
  id: z.string(),
  contactId: z.string().nullish(),
  source: z.string().nullish(),
  sourceLabel: z.string().nullish(),
  status: z.string(),
  assigneeMembershipId: z.string().nullish(),
  assigneeEmail: z.string().nullish(),
  assignmentStatus: z.string().nullish(),
  escalationLevel: z.number().nullish(),
  escalationTarget: z.string().nullish(),
  escalationCount: z.number().nullish(),
  ownerUnavailable: z.boolean().nullish(),
  assignedAt: z.string().nullish(),
  acknowledgedAt: z.string().nullish(),
  firstAcknowledgedAt: z.string().nullish(),
  lastActivityAt: z.string().nullish(),
  acknowledgementDeadline: z.string().nullish(),
  version: z.number().nullish(),
  createdAt: z.string().nullish(),
});

export type Lead = z.infer<typeof leadSchema>;

const leadsSchema = paged(leadSchema);

const createLeadResultSchema = z.object({
  leadId: z.string(),
  assigneeMembershipId: z.string().nullish(),
  unassignedReason: z.object({ code: z.string(), message: z.string() }).nullish(),
});

const availabilityMemberSchema = z.object({
  membershipId: z.string(),
  email: z.string(),
  baseLevel: z.string().nullish(),
  availabilityStatus: z.string(),
  openLeadCount: z.number().nullish(),
});

export type AvailabilityMember = z.infer<typeof availabilityMemberSchema>;

const availabilitySchema = z.object({ members: z.array(availabilityMemberSchema) });

const availabilityResultSchema = z.object({
  reassignedLeadIds: z.array(z.string()).default([]),
  flaggedLeadIds: z.array(z.string()).default([]),
});

export type AvailabilityResult = z.infer<typeof availabilityResultSchema>;

const recoveryItemSchema = z.object({
  leadId: z.string(),
  reasons: z.array(z.string()).optional(),
  reasonLabels: z.array(z.string()).default([]),
  sourceLabel: z.string().nullish(),
  assigneeMembershipId: z.string().nullish(),
  assigneeEmail: z.string().nullish(),
  escalationCount: z.number().nullish(),
  createdAt: z.string().nullish(),
  lastActivityAt: z.string().nullish(),
});

export type RecoveryItem = z.infer<typeof recoveryItemSchema>;

const recoverySchema = z.object({ items: z.array(recoveryItemSchema), total: z.number() });

export const assignmentRulesSchema = z.object({
  mode: z.string().nullish(),
  maxOpenLeadsPerEmployee: z.number(),
  acknowledgementWindowSeconds: z.number(),
  escalationLevels: z.array(z.object({ target: z.string(), windowSeconds: z.number() })),
  backupMembershipId: z.string().nullable(),
  managerMembershipId: z.string().nullable(),
  idleRecoveryMinutes: z.number(),
  recoveryMinEscalations: z.number(),
});

export type AssignmentRules = z.infer<typeof assignmentRulesSchema>;

const leadFormSchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceLabel: z.string().nullish(),
  enabled: z.boolean().nullish(),
  endpoint: z.string(),
});

export type LeadForm = z.infer<typeof leadFormSchema>;

const leadFormsSchema = z.object({ forms: z.array(leadFormSchema) });

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useLeads(query: Record<string, string>) {
  return useQuery({
    queryKey: ['leads', query],
    queryFn: () => apiRequest(`/api/leads?${toQueryString(query)}`, leadsSchema),
  });
}

export function useAvailability() {
  return useQuery({
    queryKey: ['availability'],
    queryFn: () => apiRequest('/api/availability', availabilitySchema),
  });
}

export function useRecoveryQueue() {
  return useQuery({
    queryKey: ['recovery-queue'],
    queryFn: () => apiRequest('/api/recovery-queue', recoverySchema),
  });
}

export function useAssignmentRules() {
  return useQuery({
    queryKey: ['assignment-rules'],
    queryFn: () => apiRequest('/api/assignment-rules', assignmentRulesSchema),
  });
}

export function useLeadForms() {
  return useQuery({
    queryKey: ['lead-forms'],
    queryFn: () => apiRequest('/api/lead-forms', leadFormsSchema),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function useLeadMutation<TValues, TResult>(mutationFn: (values: TValues) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of ['leads', 'recovery-queue', 'availability', 'dashboard', 'contact-view']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useAcknowledgeLead() {
  return useLeadMutation((leadId: string) =>
    apiRequest(`/api/leads/${leadId}/acknowledge`, z.object({ acknowledged: z.boolean() }), {
      method: 'POST',
    }),
  );
}

export interface NewLeadInput {
  readonly firstName: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly phone?: string;
}

export function useCreateLead() {
  return useLeadMutation((values: NewLeadInput) =>
    apiRequest('/api/leads', createLeadResultSchema, { method: 'POST', body: values }),
  );
}

export function useReassignLead() {
  return useLeadMutation((values: { leadId: string; toMembershipId?: string }) =>
    apiRequest(`/api/leads/${values.leadId}/reassign`, z.object({ reassigned: z.boolean() }), {
      method: 'POST',
      body: values.toMembershipId === undefined ? {} : { toMembershipId: values.toMembershipId },
    }),
  );
}

export function useSetAvailability() {
  return useLeadMutation((values: { membershipId: string; status: AvailabilityStatus }) =>
    apiRequest(`/api/availability/${values.membershipId}`, availabilityResultSchema, {
      method: 'PATCH',
      body: { status: values.status },
    }),
  );
}

export function useUpdateAssignmentRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: Partial<AssignmentRules>) =>
      // The response may carry only some fields, so it is not trusted as the
      // full rules; the editor refetches the authoritative copy instead.
      apiRequest('/api/assignment-rules', z.unknown(), { method: 'PATCH', body: values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assignment-rules'] });
    },
  });
}

export function useCreateLeadForm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: { name: string; sourceLabel?: string }) =>
      apiRequest('/api/lead-forms', leadFormSchema, { method: 'POST', body: values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead-forms'] });
    },
  });
}
