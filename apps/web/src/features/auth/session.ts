import { BASE_LEVELS, type Permission } from '@ubmp/domain';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError, apiRequest } from '../../lib/api.js';

/**
 * The signed-in member, and the mutations that change who that is (F1.1).
 *
 * The session is a query rather than React state, so reloading the page
 * re-reads it from the cookie and the user stays signed in.
 */
export const identitySchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  workspace: z.object({ id: z.string(), name: z.string() }),
  membership: z.object({
    id: z.string(),
    baseLevel: z.enum(BASE_LEVELS),
    permissions: z.array(z.string()),
  }),
});

export type Identity = z.infer<typeof identitySchema>;

export const sessionQueryKey = ['session'] as const;

/**
 * `null` means "definitely signed out", which is different from `undefined`
 * while the first request is still in flight. The route guard waits for the
 * difference rather than bouncing a signed-in user to the sign-in page.
 */
export function useSession(): UseQueryResult<Identity | null, Error> {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      try {
        return await apiRequest('/api/auth/me', identitySchema);
      } catch (error) {
        // Not signed in is an answer, not a failure.
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

/** Whether the signed-in member holds a permission. Drives what is rendered. */
export function useHasPermission(permission: Permission): boolean {
  const { data } = useSession();
  return data?.membership.permissions.includes(permission) ?? false;
}

export interface SignUpValues {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly workspaceName: string;
}

export function useSignUp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (values: SignUpValues) =>
      apiRequest('/api/auth/signup', identitySchema, { method: 'POST', body: values }),
    onSuccess: (identity) => {
      queryClient.setQueryData(sessionQueryKey, identity);
    },
  });
}

export interface SignInValues {
  readonly email: string;
  readonly password: string;
}

export function useSignIn() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (values: SignInValues) =>
      apiRequest('/api/auth/login', identitySchema, { method: 'POST', body: values }),
    onSuccess: (identity) => {
      queryClient.setQueryData(sessionQueryKey, identity);
    },
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiRequest('/api/auth/logout', z.unknown(), { method: 'POST' }),
    onSuccess: () => {
      // Everything cached belonged to the member who just left.
      queryClient.setQueryData(sessionQueryKey, null);
      void queryClient.invalidateQueries();
    },
  });
}
