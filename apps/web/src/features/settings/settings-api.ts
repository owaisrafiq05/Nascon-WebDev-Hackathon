import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiRequest } from '../../lib/api.js';

/** Per-member settings: own calendar (I3) and own Telegram alerts (I4). */
const connectionSchema = z.object({
  configured: z.boolean(),
  status: z.string(),
  googleEmail: z.string().nullish(),
  timeZone: z.string().nullish(),
});

export type CalendarConnection = z.infer<typeof connectionSchema>;

const notificationSettingsSchema = z.object({
  telegramChatId: z.string().nullish(),
  telegramConnected: z.boolean().nullish(),
  botUsername: z.string().nullish(),
});

export function useCalendarConnection() {
  return useQuery({
    queryKey: ['calendar', 'connection'],
    queryFn: () => apiRequest('/api/calendar/connection', connectionSchema),
  });
}

export function useConnectCalendar() {
  return useMutation({
    mutationFn: () =>
      apiRequest('/api/calendar/connect', z.object({ authorizationUrl: z.string() }), {
        method: 'POST',
      }),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl);
    },
  });
}

export function useDisconnectCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/calendar/connection', z.unknown(), { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

export function useNotificationSettings() {
  return useQuery({
    queryKey: ['notification-settings'],
    queryFn: () => apiRequest('/api/me/notification-settings', notificationSettingsSchema),
  });
}

export function useSaveNotificationSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (telegramChatId: string | null) =>
      apiRequest('/api/me/notification-settings', notificationSettingsSchema, {
        method: 'PUT',
        body: { telegramChatId },
      }),
    onSuccess: (settings) => {
      queryClient.setQueryData(['notification-settings'], settings);
    },
  });
}

export function useSendTestAlert() {
  return useMutation({
    mutationFn: () =>
      apiRequest('/api/me/notification-settings/test', z.object({ sent: z.boolean() }), {
        method: 'POST',
      }),
  });
}
