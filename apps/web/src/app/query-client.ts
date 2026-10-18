import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../lib/api.js';

/**
 * One place for the caching and retry policy.
 *
 * A 4xx is never retried: an unauthorized or invalid request will fail the same
 * way every time, and retrying a 401 would mask an expired session.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
