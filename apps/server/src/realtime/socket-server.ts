import type { Server as HttpServer } from 'node:http';

import { Server, type Socket } from 'socket.io';

import { SESSION_COOKIE } from '../http/middleware/authenticate.js';
import type { Logger } from '../logger.js';
import { resolveSession, type AuthContext } from '../services/session-service.js';

/**
 * Realtime delivery (Q11).
 *
 * The handshake authenticates the **same** session cookie as the HTTP API, so a
 * socket cannot exist without a live, unrevoked session. An unauthenticated
 * handshake is refused outright rather than connected and ignored.
 *
 * Every socket joins exactly two rooms, `workspace:{id}` and `user:{membershipId}`,
 * and the relay only ever emits to a room. Nothing is broadcast to all sockets,
 * which is what makes cross-workspace leakage structurally impossible (F1.6).
 *
 * Payloads carry ids and an event type only. The browser refetches through the
 * permission-checked endpoint, so a socket is never a way around
 * `requirePermission`.
 */
export const SOCKET_PATH = '/api/socket.io';

export interface RealtimeEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /** Set on the copy sent to the member the event concerns. */
  readonly personal?: boolean;
}

export interface RealtimeHub {
  readonly io: Server;
  emitToWorkspace(workspaceId: string, event: RealtimeEvent): void;
  emitToMember(membershipId: string, event: RealtimeEvent): void;
  close(): Promise<void>;
}

export function workspaceRoom(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function memberRoom(membershipId: string): string {
  return `user:${membershipId}`;
}

/** Reads one cookie from a raw `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      const value = rest.join('=');
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

interface SocketData {
  auth: AuthContext;
}

export function createRealtimeHub(
  httpServer: HttpServer,
  options: { readonly webOrigins: readonly string[]; readonly logger: Logger },
): RealtimeHub {
  const io = new Server<
    Record<string, never>,
    Record<string, never>,
    Record<string, never>,
    SocketData
  >(httpServer, {
    path: SOCKET_PATH,
    cors: { origin: [...options.webOrigins], credentials: true },
    serveClient: false,
  });

  io.use((socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    if (token === undefined || token === '') {
      next(new Error('UNAUTHENTICATED'));
      return;
    }

    resolveSession(token)
      .then((auth) => {
        if (auth === null) {
          next(new Error('UNAUTHENTICATED'));
          return;
        }
        socket.data.auth = auth;
        next();
      })
      .catch((error: unknown) => {
        options.logger.error({ err: error }, 'socket handshake failed');
        next(new Error('UNAVAILABLE'));
      });
  });

  io.on('connection', (socket: Socket) => {
    const auth = (socket.data as SocketData).auth;
    void socket.join([
      workspaceRoom(auth.workspaceId.toString()),
      memberRoom(auth.membershipId.toString()),
    ]);
  });

  const hub = io as unknown as Server;

  return {
    io: hub,
    emitToWorkspace(workspaceId, event) {
      hub.to(workspaceRoom(workspaceId)).emit('event', event);
    },
    emitToMember(membershipId, event) {
      hub.to(memberRoom(membershipId)).emit('event', event);
    },
    async close() {
      await new Promise<void>((resolve) => {
        void hub.close(() => {
          resolve();
        });
      });
    },
  };
}
