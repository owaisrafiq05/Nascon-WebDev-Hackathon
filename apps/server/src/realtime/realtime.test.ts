import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { Types } from 'mongoose';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { OutboxEventModel } from '../db/models/outbox-event.js';
import { appendOutbox } from '../repositories/outbox.js';
import {
  createTestApp,
  resetDatabase,
  signUpOwner,
  silentLogger,
  startTestDatabase,
  stopTestDatabase,
} from '../test/harness.js';
import { relayOnce } from './outbox-relay.js';
import { createRealtimeHub, readCookie, SOCKET_PATH, type RealtimeHub } from './socket-server.js';

let app: Express;
let server: HttpServer;
let hub: RealtimeHub;
let baseUrl: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  await startTestDatabase();
  app = createTestApp();
  server = createServer(app);
  hub = createRealtimeHub(server, { webOrigins: ['http://localhost:5173'], logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopTestDatabase();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await resetDatabase();
});

function sessionCookieOf(client: { agent: unknown }): string {
  // supertest's agent keeps a cookie jar; read the session cookie from it.
  const jar = (
    client.agent as {
      jar: { getCookie(name: string, access: unknown): { value: string } | undefined };
    }
  ).jar;
  const cookie = jar.getCookie('ubmp.sid', {
    domain: '127.0.0.1',
    path: '/',
    secure: false,
    script: false,
  });
  if (cookie === undefined) throw new Error('no session cookie');
  return cookie.value;
}

function open(cookie: string | undefined): Socket {
  const socket = connect(baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...(cookie === undefined ? {} : { extraHeaders: { Cookie: `ubmp.sid=${cookie}` } }),
  });
  sockets.push(socket);
  return socket;
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });
}

describe('readCookie', () => {
  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; ubmp.sid=abc%3D; b=2', 'ubmp.sid')).toBe('abc=');
    expect(readCookie(undefined, 'ubmp.sid')).toBeUndefined();
  });
});

describe('socket handshake (Q11)', () => {
  it('rejects a handshake without a session cookie', async () => {
    const socket = open(undefined);
    await expect(connected(socket)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('rejects a handshake with a forged session cookie', async () => {
    const socket = open('not-a-real-session');
    await expect(connected(socket)).rejects.toThrow('UNAUTHENTICATED');
  });
});

describe('outbox relay (Q11, F1.6)', () => {
  it('delivers an event to its own workspace and never to another', async () => {
    const ownerA = await signUpOwner(app, { workspaceName: 'A' });
    const ownerB = await signUpOwner(app, { workspaceName: 'B' });

    const socketA = open(sessionCookieOf(ownerA));
    const socketB = open(sessionCookieOf(ownerB));
    await Promise.all([connected(socketA), connected(socketB)]);

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    socketA.on('event', (event) => receivedA.push(event));
    socketB.on('event', (event) => receivedB.push(event));

    await appendOutbox(new Types.ObjectId(ownerA.workspaceId), 'lead.created', { leadId: 'x1' });
    expect(await relayOnce(hub)).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedA).toEqual([{ type: 'lead.created', payload: { leadId: 'x1' } }]);
    expect(receivedB).toEqual([]);

    const row = await OutboxEventModel.findOne({}).lean();
    expect(row?.deliveredAt).toBeInstanceOf(Date);
  });

  it('also sends a personal copy to the member the event names', async () => {
    const owner = await signUpOwner(app);
    const socket = open(sessionCookieOf(owner));
    await connected(socket);

    const received: { personal?: boolean }[] = [];
    socket.on('event', (event: { personal?: boolean }) => received.push(event));

    await appendOutbox(
      new Types.ObjectId(owner.workspaceId),
      'lead.escalated',
      { leadId: 'x2' },
      new Types.ObjectId(owner.membershipId),
    );
    await relayOnce(hub);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toHaveLength(2);
    expect(received.some((event) => event.personal === true)).toBe(true);
  });

  it('does not deliver a row twice', async () => {
    const owner = await signUpOwner(app);
    await appendOutbox(new Types.ObjectId(owner.workspaceId), 'lead.created', { leadId: 'x3' });

    expect(await relayOnce(hub)).toBe(1);
    expect(await relayOnce(hub)).toBe(0);
  });
});
