import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';

/** The operational dashboard (P5): one request supplies every tile. */
export const DASHBOARD_RANGES = ['today', '7d', '30d'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export const RANGE_LABELS: Record<DashboardRange, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

const tileSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.number().nullish(),
  display: z.string(),
  description: z.string().default(''),
  drillDown: z
    .object({ path: z.string(), query: z.record(z.string(), z.string()).default({}) })
    .nullish(),
  detail: z.unknown().optional(),
});

export type DashboardTile = z.infer<typeof tileSchema>;

const dashboardSchema = z.object({
  range: z.string(),
  scope: z.string().nullish(),
  currency: z.string().nullish(),
  generatedAt: z.string().nullish(),
  hiddenTiles: z.array(z.string()).default([]),
  tiles: z.array(tileSchema),
});

export type Dashboard = z.infer<typeof dashboardSchema>;

/** Sent so "today" means the viewer's day, not the server's. */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function useDashboard(range: DashboardRange) {
  return useQuery({
    queryKey: ['dashboard', range],
    queryFn: () =>
      apiRequest(
        `/api/dashboard?${new URLSearchParams({ range, tz: browserTimeZone() }).toString()}`,
        dashboardSchema,
      ),
  });
}

export function useSaveDashboardPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hiddenTiles: string[]) =>
      apiRequest('/api/dashboard/preferences', z.object({ hiddenTiles: z.array(z.string()) }), {
        method: 'PUT',
        body: { hiddenTiles },
      }),
    // Optimistic: the checkbox follows the click at once instead of snapping
    // back until the server answers. A failure restores what was there.
    onMutate: async (hiddenTiles) => {
      await queryClient.cancelQueries({ queryKey: ['dashboard'] });
      const previous = queryClient.getQueriesData<Dashboard>({ queryKey: ['dashboard'] });
      setHiddenTiles(queryClient, hiddenTiles);
      return { previous };
    },
    onError: (_error, _hiddenTiles, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
    },
    onSuccess: ({ hiddenTiles }) => {
      setHiddenTiles(queryClient, hiddenTiles);
    },
  });
}

/** Preferences are per member, not per range, so every cached range updates. */
function setHiddenTiles(queryClient: QueryClient, hiddenTiles: string[]): void {
  queryClient.setQueriesData<Dashboard>({ queryKey: ['dashboard'] }, (old) =>
    old === undefined ? old : { ...old, hiddenTiles },
  );
}

export function drillDownHref(drillDown: { path: string; query: Record<string, string> }): string {
  const query = new URLSearchParams(drillDown.query).toString();
  return query === '' ? drillDown.path : `${drillDown.path}?${query}`;
}

const stageDetailSchema = z.object({
  byStage: z.array(
    z.object({
      stageId: z.string(),
      stageName: z.string(),
      count: z.number().optional(),
      display: z.string(),
    }),
  ),
});

const availabilityDetailSchema = z.object({
  available: z.number(),
  busy: z.number(),
  on_leave: z.number(),
  offline: z.number(),
  availableForAssignment: z.number().optional(),
});

export function parseStageDetail(detail: unknown) {
  const parsed = stageDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : null;
}

export function parseAvailabilityDetail(detail: unknown) {
  const parsed = availabilityDetailSchema.safeParse(detail);
  return parsed.success ? parsed.data : null;
}
