import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';
import { toQueryString } from '../../lib/query-string.js';
import { paged } from '../../lib/schemas.js';

/** Appointments and the employee calendars behind them (I3). */
export const appointmentSchema = z.object({
  id: z.string(),
  contactId: z.string().nullish(),
  contactName: z.string().nullish(),
  opportunityId: z.string().nullish(),
  employeeMembershipId: z.string().nullish(),
  employeeEmail: z.string().nullish(),
  title: z.string(),
  notes: z.string().nullish(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string().nullish(),
  status: z.string(),
  googleEventLink: z.string().nullish(),
  version: z.number(),
  createdAt: z.string().nullish(),
});

export type Appointment = z.infer<typeof appointmentSchema>;

const employeeSchema = z.object({
  membershipId: z.string(),
  email: z.string(),
  name: z.string().nullish(),
  calendarStatus: z.string().nullish(),
  timeZone: z.string().nullish(),
  bookable: z.boolean(),
  reason: z.string().nullish(),
});

export type CalendarEmployee = z.infer<typeof employeeSchema>;

const intervalSchema = z.object({ start: z.string(), end: z.string() });
export type Interval = z.infer<typeof intervalSchema>;

export function useCalendarEmployees() {
  return useQuery({
    queryKey: ['calendar', 'employees'],
    queryFn: () =>
      apiRequest('/api/calendar/employees', z.object({ items: z.array(employeeSchema) })),
  });
}

export function useBusyIntervals(query: { membershipId: string; from: string; to: string } | null) {
  return useQuery({
    queryKey: ['calendar', 'busy', query],
    queryFn: () =>
      apiRequest(
        `/api/calendar/busy?${toQueryString(query ?? {})}`,
        z.object({ busy: z.array(intervalSchema), timeZone: z.string().nullish() }),
      ),
    enabled: query !== null,
  });
}

export function useAppointments(query: {
  contactId?: string;
  opportunityId?: string;
  employeeMembershipId?: string;
  upcoming?: boolean;
  page?: number;
}) {
  return useQuery({
    queryKey: ['appointments', query],
    queryFn: () =>
      apiRequest(
        `/api/appointments?${toQueryString({ ...query, upcoming: query.upcoming === true ? 'true' : undefined })}`,
        paged(appointmentSchema),
      ),
  });
}

/** Clashing intervals from a 409, or an empty list if the error carries none. */
export function conflictsOf(error: unknown): Interval[] {
  const details = (error as { details?: Record<string, unknown> } | null)?.details;
  const parsed = z.array(intervalSchema).safeParse(details?.['conflicts']);
  return parsed.success ? parsed.data : [];
}

function useAppointmentMutation<TValues, TResult>(
  mutationFn: (values: TValues) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of ['appointments', 'contact-view', 'calendar']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export interface BookInput {
  readonly contactId: string;
  readonly opportunityId?: string;
  readonly employeeMembershipId: string;
  readonly title: string;
  readonly notes?: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly allowOverlap?: boolean;
}

export function useBookAppointment() {
  return useAppointmentMutation((values: BookInput) =>
    apiRequest('/api/appointments', appointmentSchema, { method: 'POST', body: values }),
  );
}

export interface RescheduleInput {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly version: number;
  readonly allowOverlap?: boolean;
}

export function useRescheduleAppointment() {
  return useAppointmentMutation((values: RescheduleInput) => {
    const { id, ...rest } = values;
    return apiRequest(`/api/appointments/${id}`, appointmentSchema, {
      method: 'PATCH',
      body: rest,
    });
  });
}

export function useCancelAppointment() {
  return useAppointmentMutation((id: string) =>
    apiRequest(`/api/appointments/${id}/cancel`, appointmentSchema, { method: 'POST' }),
  );
}
