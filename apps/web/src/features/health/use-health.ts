import { healthResponseSchema, type HealthResponse } from '@ubmp/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

export const healthQueryKey = ['health'] as const;

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiRequest('/api/health', healthResponseSchema, signal ? { signal } : {});
}

/**
 * Polls the API so the status card reflects a database that goes away or comes
 * back without the user reloading the page. From P5 live updates arrive over
 * Socket.IO instead of by polling (Q11); this stays as the connectivity check.
 *
 * The retry policy is deliberately not set here: it belongs to the query client
 * (`app/query-client.ts`), so one rule covers every query.
 */
export function useHealth(): UseQueryResult<HealthResponse, Error> {
  return useQuery({
    queryKey: healthQueryKey,
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 15_000,
  });
}
