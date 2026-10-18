import {
  CUSTOM_FIELD_TYPES,
  FILTER_FIELDS,
  FILTER_OPERATORS,
  STAGE_OUTCOMES,
  type Filter,
} from '@ubmp/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';
import { appointmentSchema } from '../calendar/calendar-api.js';
import { conversationSchema } from '../messaging/messaging-api.js';
import { paymentSchema } from '../payments/payments-api.js';

/**
 * The CRM's data layer (F2.1 - F2.8).
 *
 * Every response is parsed with a schema, so a contract change fails loudly
 * here rather than rendering `undefined` three components deep.
 */
const pageInfoSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
  hasNextPage: z.boolean().optional(),
  hasPreviousPage: z.boolean().optional(),
});

export const contactSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  tags: z.array(z.string()),
  ownerMembershipId: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  optedOutOfMessaging: z.boolean(),
  lastActivityAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
});

export type Contact = z.infer<typeof contactSchema>;

const contactsSchema = z.object({
  items: z.array(contactSchema),
  pageInfo: pageInfoSchema,
});

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  phone: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  version: z.number(),
  createdAt: z.string(),
});

export type Company = z.infer<typeof companySchema>;

const companiesSchema = z.object({
  items: z.array(companySchema),
  pageInfo: pageInfoSchema,
});

export const stageSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  outcome: z.enum(STAGE_OUTCOMES),
});

export type Stage = z.infer<typeof stageSchema>;

export const pipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  stages: z.array(stageSchema),
  version: z.number(),
});

export type Pipeline = z.infer<typeof pipelineSchema>;

const pipelinesSchema = z.object({ pipelines: z.array(pipelineSchema) });

export const customFieldSchema = z.object({
  id: z.string(),
  entity: z.enum(['contact', 'company', 'opportunity']).optional(),
  pipelineId: z.string().nullable().optional(),
  key: z.string(),
  label: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string()),
  required: z.boolean(),
  requiredInStageIds: z.array(z.string()),
  position: z.number().optional(),
});

export type CustomField = z.infer<typeof customFieldSchema>;

const customFieldsSchema = z.object({ customFields: z.array(customFieldSchema) });

/**
 * An opportunity as the server sends it, with the masking flag.
 *
 * `value` is `null` either because none was recorded or because this reader may
 * not see it; `valueMasked` is what tells the two apart (F1.4).
 */
export const opportunitySchema = z.object({
  id: z.string(),
  contactId: z.string().nullable(),
  pipelineId: z.string().nullable(),
  name: z.string(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  stageId: z.string(),
  stageOutcome: z.enum(STAGE_OUTCOMES),
  ownerMembershipId: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  version: z.number(),
  createdAt: z.string(),
  valueMasked: z.boolean().optional(),
});

export type Opportunity = z.infer<typeof opportunitySchema>;

const opportunitiesSchema = z.object({
  items: z.array(opportunitySchema),
  pageInfo: pageInfoSchema,
});

const activityEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  targetKind: z.string().optional(),
  targetId: z.string().optional(),
  actor: z.object({ label: z.string(), membershipId: z.string().nullable() }),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export type ActivityEntry = z.infer<typeof activityEntrySchema>;

/** A customer-view section: the items, plus why it is empty if it cannot be filled. */
const sectionSchema = <TItem extends z.ZodType>(item: TItem) =>
  z.object({
    items: z.array(item),
    availableFrom: z.string().nullish(),
    reason: z.string().nullish(),
  });

export const customerViewSchema = z.object({
  contact: contactSchema.extend({ displayName: z.string() }),
  company: companySchema.partial().extend({ id: z.string(), name: z.string() }).nullable(),
  assignedEmployee: z
    .object({
      membershipId: z.string(),
      email: z.string(),
      name: z.string(),
      availabilityStatus: z.string(),
    })
    .nullable(),
  opportunities: z.array(
    opportunitySchema.partial().extend({
      id: z.string(),
      name: z.string(),
      stageName: z.string().nullable(),
      pipelineName: z.string().nullable(),
    }),
  ),
  conversations: sectionSchema(conversationSchema),
  payments: sectionSchema(paymentSchema),
  appointments: sectionSchema(appointmentSchema),
  activity: z.array(activityEntrySchema),
});

export type CustomerView = z.infer<typeof customerViewSchema>;

export const savedListSchema = z.object({
  id: z.string(),
  name: z.string(),
  entity: z.enum(['contact', 'company', 'opportunity']),
  pipelineId: z.string().nullable(),
  filter: z.object({
    join: z.enum(['and', 'or']),
    criteria: z.array(
      z.object({
        field: z.enum(FILTER_FIELDS),
        key: z.string().optional(),
        operator: z.enum(FILTER_OPERATORS),
        value: z.unknown().optional(),
      }),
    ),
  }),
  sharedWithWorkspace: z.boolean(),
  createdByMembershipId: z.string().nullable(),
  createdAt: z.string(),
});

export type SavedList = z.infer<typeof savedListSchema>;

const savedListsSchema = z.object({ savedLists: z.array(savedListSchema) });

const filterResultSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  pageInfo: pageInfoSchema,
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const contactsKey = (query: Record<string, string>) => ['contacts', query] as const;
export const contactViewKey = (id: string) => ['contact-view', id] as const;
export const pipelinesKey = ['pipelines'] as const;
export const customFieldsKey = (entity: string, pipelineId?: string) =>
  ['custom-fields', entity, pipelineId ?? null] as const;
export const opportunitiesKey = (query: Record<string, string>) =>
  ['opportunities', query] as const;
export const savedListsKey = ['saved-lists'] as const;

function toQueryString(query: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== '') params.set(key, value);
  }
  return params.toString();
}

export function useContacts(query: Record<string, string>) {
  return useQuery({
    queryKey: contactsKey(query),
    queryFn: () => apiRequest(`/api/contacts?${toQueryString(query)}`, contactsSchema),
  });
}

export function useCompanies() {
  return useQuery({
    queryKey: ['companies'],
    queryFn: () => apiRequest('/api/companies?limit=100', companiesSchema),
  });
}

export function useCustomerView(contactId: string) {
  return useQuery({
    queryKey: contactViewKey(contactId),
    queryFn: () => apiRequest(`/api/contacts/${contactId}/view`, customerViewSchema),
  });
}

export function usePipelines() {
  return useQuery({
    queryKey: pipelinesKey,
    queryFn: () => apiRequest('/api/pipelines', pipelinesSchema),
  });
}

export function useCustomFields(entity: string, pipelineId?: string) {
  return useQuery({
    queryKey: customFieldsKey(entity, pipelineId),
    queryFn: () =>
      apiRequest(
        `/api/custom-fields?${toQueryString({ entity, ...(pipelineId === undefined ? {} : { pipelineId }) })}`,
        customFieldsSchema,
      ),
  });
}

export function useOpportunities(query: Record<string, string>) {
  return useQuery({
    queryKey: opportunitiesKey(query),
    queryFn: () => apiRequest(`/api/opportunities?${toQueryString(query)}`, opportunitiesSchema),
  });
}

export function useSavedLists() {
  return useQuery({
    queryKey: savedListsKey,
    queryFn: () => apiRequest('/api/saved-lists', savedListsSchema),
  });
}

export function useRunFilter() {
  return useMutation({
    mutationFn: (input: { entity: string; pipelineId?: string; filter: Filter }) =>
      apiRequest('/api/filters/run?limit=25', filterResultSchema, {
        method: 'POST',
        body: input,
      }),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Invalidates everything the CRM shows after a write.
 *
 * Broad on purpose: a stage move changes the board, the contact page and any
 * saved list, and a narrower rule would be one more thing to keep correct as
 * screens are added.
 */
function useCrmMutation<TValues, TResult>(mutationFn: (values: TValues) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of [
        ['contacts'],
        ['contact-view'],
        ['companies'],
        ['opportunities'],
        pipelinesKey,
        savedListsKey,
        ['custom-fields'],
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useCreateContact() {
  return useCrmMutation((values: Record<string, unknown>) =>
    apiRequest('/api/contacts', contactSchema, { method: 'POST', body: values }),
  );
}

export function useUpdateContact() {
  return useCrmMutation((values: { id: string } & Record<string, unknown>) => {
    const { id, ...rest } = values;
    return apiRequest(`/api/contacts/${id}`, contactSchema, { method: 'PATCH', body: rest });
  });
}

export function useAddNote() {
  return useCrmMutation((values: { contactId: string; body: string }) =>
    apiRequest(`/api/contacts/${values.contactId}/notes`, z.unknown(), {
      method: 'POST',
      body: { body: values.body },
    }),
  );
}

export function useCreateOpportunity() {
  return useCrmMutation((values: Record<string, unknown>) =>
    apiRequest('/api/opportunities', opportunitySchema, { method: 'POST', body: values }),
  );
}

export function useUpdateOpportunity() {
  return useCrmMutation((values: { id: string } & Record<string, unknown>) => {
    const { id, ...rest } = values;
    return apiRequest(`/api/opportunities/${id}`, opportunitySchema, {
      method: 'PATCH',
      body: rest,
    });
  });
}

/** Moving between stages, used by both the drag handler and the menu (F2.4). */
export function useMoveOpportunity() {
  return useCrmMutation(
    (values: {
      id: string;
      stageId: string;
      version: number;
      customFields?: Record<string, unknown>;
    }) => {
      const { id, ...rest } = values;
      return apiRequest(`/api/opportunities/${id}/stage`, opportunitySchema, {
        method: 'PATCH',
        body: rest,
      });
    },
  );
}

export function useCreateCustomField() {
  return useCrmMutation((values: Record<string, unknown>) =>
    apiRequest('/api/custom-fields', customFieldSchema, { method: 'POST', body: values }),
  );
}

export function useDeleteCustomField() {
  return useCrmMutation((fieldId: string) =>
    apiRequest(`/api/custom-fields/${fieldId}`, z.unknown(), { method: 'DELETE' }),
  );
}

export function useCreatePipeline() {
  return useCrmMutation((values: { name: string; stageNames?: string[] }) =>
    apiRequest('/api/pipelines', pipelineSchema, { method: 'POST', body: values }),
  );
}

export function useAddStage() {
  return useCrmMutation((values: { pipelineId: string; name: string; outcome: string }) =>
    apiRequest(`/api/pipelines/${values.pipelineId}/stages`, pipelineSchema, {
      method: 'POST',
      body: { name: values.name, outcome: values.outcome },
    }),
  );
}

export function useRenameStage() {
  return useCrmMutation((values: { pipelineId: string; stageId: string; name: string }) =>
    apiRequest(`/api/pipelines/${values.pipelineId}/stages/${values.stageId}`, pipelineSchema, {
      method: 'PATCH',
      body: { name: values.name },
    }),
  );
}

export function useReorderStages() {
  return useCrmMutation((values: { pipelineId: string; stageIds: string[] }) =>
    apiRequest(`/api/pipelines/${values.pipelineId}/stage-order`, pipelineSchema, {
      method: 'PATCH',
      body: { stageIds: values.stageIds },
    }),
  );
}

/** `moveToStageId` is required when the stage still holds opportunities (F2.5). */
export function useDeleteStage() {
  return useCrmMutation((values: { pipelineId: string; stageId: string; moveToStageId?: string }) =>
    apiRequest(
      `/api/pipelines/${values.pipelineId}/stages/${values.stageId}?${toQueryString(
        values.moveToStageId === undefined ? {} : { moveToStageId: values.moveToStageId },
      )}`,
      z.object({ movedOpportunities: z.number() }),
      { method: 'DELETE' },
    ),
  );
}

export function useCreateSavedList() {
  return useCrmMutation(
    (values: { name: string; entity: string; pipelineId?: string; filter: Filter }) =>
      apiRequest('/api/saved-lists', savedListSchema, { method: 'POST', body: values }),
  );
}

export function useDeleteSavedList() {
  return useCrmMutation((listId: string) =>
    apiRequest(`/api/saved-lists/${listId}`, z.unknown(), { method: 'DELETE' }),
  );
}

export function useSavedListResults(listId: string | null) {
  return useQuery({
    queryKey: ['saved-list-results', listId],
    queryFn: () =>
      apiRequest(
        `/api/saved-lists/${listId ?? ''}/results?limit=25`,
        filterResultSchema.extend({ savedList: savedListSchema }),
      ),
    enabled: listId !== null,
  });
}
