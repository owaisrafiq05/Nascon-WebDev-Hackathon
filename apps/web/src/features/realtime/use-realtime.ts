import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

import { personalNotice, queryKeysForEvent, realtimeEventSchema } from './event-keys.js';

const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

/**
 * Connects the authenticated socket once and turns server events into query
 * invalidations, so every open screen refetches what changed (P5).
 *
 * Returns the latest personal notice for a live region to announce.
 */
export function useRealtime(): { notice: string | null; dismiss: () => void } {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // The base may be a full URL; the socket path stays under /api either way.
    const socket = io(API_BASE_URL === '' ? undefined : API_BASE_URL, {
      path: '/api/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });

    socket.on('event', (raw: unknown) => {
      const parsed = realtimeEventSchema.safeParse(raw);
      if (!parsed.success) return;

      for (const queryKey of queryKeysForEvent(parsed.data.type)) {
        void queryClient.invalidateQueries({ queryKey });
      }

      const text = personalNotice(parsed.data);
      if (text !== null) setNotice(text);
    });

    return () => {
      socket.disconnect();
    };
  }, [queryClient]);

  return {
    notice,
    dismiss: () => {
      setNotice(null);
    },
  };
}
