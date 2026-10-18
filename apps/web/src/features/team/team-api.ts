import { BASE_LEVELS, type BaseLevel } from '@ubmp/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';

/** The Team page's data (F1.2, F1.3). */
const memberSchema = z.object({
  membershipId: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  baseLevel: z.enum(BASE_LEVELS),
  permissionSetIds: z.array(z.string()),
  extraPermissions: z.array(z.string()),
  permissions: z.array(z.string()),
  availabilityStatus: z.string(),
});

const membersSchema = z.object({
  members: z.array(memberSchema),
  pendingInvites: z.array(
    z.object({
      inviteId: z.string(),
      email: z.string(),
      baseLevel: z.enum(BASE_LEVELS),
      permissionSetIds: z.array(z.string()),
      expiresAt: z.string(),
      expired: z.boolean(),
    }),
  ),
});

const permissionSetsSchema = z.object({
  permissionSets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      permissions: z.array(z.string()),
      defaultForBaseLevel: z.enum(BASE_LEVELS).nullable(),
      memberCount: z.number(),
    }),
  ),
  assignablePermissions: z.array(z.string()),
});

const inviteResultSchema = z.object({
  inviteId: z.string(),
  email: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});

export type Member = z.infer<typeof memberSchema>;
export type MembersResponse = z.infer<typeof membersSchema>;
export type PermissionSetsResponse = z.infer<typeof permissionSetsSchema>;

export const membersQueryKey = ['members'] as const;
export const permissionSetsQueryKey = ['permission-sets'] as const;

export function useMembers() {
  return useQuery({
    queryKey: membersQueryKey,
    queryFn: () => apiRequest('/api/members', membersSchema),
  });
}

/**
 * Only fetched for someone who may manage members; the endpoint refuses anyone
 * else, so asking would produce a 403 the page cannot act on.
 */
export function usePermissionSets(enabled: boolean) {
  return useQuery({
    queryKey: permissionSetsQueryKey,
    queryFn: () => apiRequest('/api/permission-sets', permissionSetsSchema),
    enabled,
  });
}

/** Refreshes the list after any change, so the page never shows stale levels. */
function useTeamMutation<TValues, TResult>(mutationFn: (values: TValues) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: membersQueryKey });
      void queryClient.invalidateQueries({ queryKey: permissionSetsQueryKey });
    },
  });
}

export function useInviteMember() {
  return useTeamMutation((values: { email: string; baseLevel: BaseLevel }) =>
    apiRequest('/api/members/invites', inviteResultSchema, { method: 'POST', body: values }),
  );
}

export function useChangeBaseLevel() {
  return useTeamMutation((values: { membershipId: string; baseLevel: BaseLevel }) =>
    apiRequest(`/api/members/${values.membershipId}/level`, z.unknown(), {
      method: 'PATCH',
      body: { baseLevel: values.baseLevel },
    }),
  );
}

export function useChangePermissions() {
  return useTeamMutation(
    (values: { membershipId: string; permissionSetIds: string[]; extraPermissions: string[] }) =>
      apiRequest(`/api/members/${values.membershipId}/permissions`, z.unknown(), {
        method: 'PATCH',
        body: {
          permissionSetIds: values.permissionSetIds,
          extraPermissions: values.extraPermissions,
        },
      }),
  );
}

export function useRemoveMember() {
  return useTeamMutation((membershipId: string) =>
    apiRequest(`/api/members/${membershipId}`, z.unknown(), { method: 'DELETE' }),
  );
}
