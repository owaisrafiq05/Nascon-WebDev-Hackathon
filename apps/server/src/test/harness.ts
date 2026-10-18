import type { Express } from 'express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { pino } from 'pino';
import request from 'supertest';

import type { ServerConfig } from '../config.js';
import { AuditEventModel } from '../db/models/audit-event.js';
import { InviteModel } from '../db/models/invite.js';
import { MembershipModel } from '../db/models/membership.js';
import { OpportunityModel } from '../db/models/opportunity.js';
import { PermissionSetModel } from '../db/models/permission-set.js';
import { SessionModel } from '../db/models/session.js';
import { UserModel } from '../db/models/user.js';
import { WorkspaceModel } from '../db/models/workspace.js';
import { createApp } from '../http/app.js';
import { CSRF_HEADER } from '../http/middleware/authenticate.js';

/**
 * Shared setup for the API tests.
 *
 * A **replica set** rather than a standalone memory server, because sign-up runs
 * in a transaction (F1.1) and MongoDB only offers transactions on a replica set.
 * This mirrors the single-node `rs0` that docker-compose.yml provisions, so the
 * tests exercise the same database topology development does.
 */
export const silentLogger = pino({ level: 'silent' });

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    env: 'test',
    isProduction: false,
    logLevel: 'silent' as ServerConfig['logLevel'],
    port: 0,
    mongoUri: '',
    webOrigins: ['http://localhost:5173'],
    jsonBodyLimit: '1mb',
    sessionTtlMs: 60 * 60 * 1_000,
    inviteTtlMs: 60 * 60 * 1_000,
    loginRateLimit: { max: 5, windowMs: 15 * 60 * 1_000 },
    ...overrides,
  };
}

const MODELS = [
  AuditEventModel,
  InviteModel,
  MembershipModel,
  OpportunityModel,
  PermissionSetModel,
  SessionModel,
  UserModel,
  WorkspaceModel,
];

let replSet: MongoMemoryReplSet | undefined;

export async function startTestDatabase(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri('ubmp-test'), { serverSelectionTimeoutMS: 20_000 });

  // Unique indexes are what enforce one account per email and one membership
  // per person per workspace, so the tests must not run before they exist.
  await Promise.all(MODELS.map((model) => model.createIndexes()));
}

export async function stopTestDatabase(): Promise<void> {
  await mongoose.disconnect();
  await replSet?.stop();
  replSet = undefined;
}

/**
 * Empties every collection between tests.
 *
 * Deletion goes through the native driver rather than Mongoose, because the
 * audit schema refuses `deleteMany` by design (F4.3). Reaching past the model is
 * acceptable here and nowhere else: it is this file's job to undo a fixture, and
 * the guard it bypasses is one of three.
 */
export async function resetDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('not connected');

  const collections = await db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

export function createTestApp(config: ServerConfig = testConfig()): Express {
  return createApp({ config, logger: silentLogger, version: '0.0.0-test' });
}

/** Reads one cookie's value out of a response's Set-Cookie headers. */
export function cookieValue(
  response: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const raw = response.headers['set-cookie'];
  const headers = Array.isArray(raw) ? (raw as string[]) : [];

  for (const header of headers) {
    const [pair] = header.split(';');
    const [key, ...rest] = (pair ?? '').split('=');
    if (key === name) return rest.join('=');
  }

  return undefined;
}

/**
 * A signed-in caller. The supertest agent keeps the session cookie, and the
 * CSRF token is attached to every unsafe request the way the web app does.
 */
export interface TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  readonly csrfToken: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly email: string;
  post(path: string, body?: unknown): request.Test;
  patch(path: string, body?: unknown): request.Test;
  put(path: string, body?: unknown): request.Test;
  delete(path: string): request.Test;
  get(path: string): request.Test;
}

interface IdentityBody {
  user: { id: string; email: string };
  workspace: { id: string };
  membership: { id: string };
}

function buildClient(
  agent: ReturnType<typeof request.agent>,
  csrfToken: string,
  identity: IdentityBody,
): TestClient {
  return {
    agent,
    csrfToken,
    userId: identity.user.id,
    workspaceId: identity.workspace.id,
    membershipId: identity.membership.id,
    email: identity.user.email,
    post: (path, body) =>
      agent
        .post(path)
        .set(CSRF_HEADER, csrfToken)
        .send(body ?? {}),
    patch: (path, body) =>
      agent
        .patch(path)
        .set(CSRF_HEADER, csrfToken)
        .send(body ?? {}),
    put: (path, body) =>
      agent
        .put(path)
        .set(CSRF_HEADER, csrfToken)
        .send(body ?? {}),
    delete: (path) => agent.delete(path).set(CSRF_HEADER, csrfToken),
    get: (path) => agent.get(path),
  };
}

/** Signs up a brand new workspace and returns its Owner, signed in. */
export async function signUpOwner(
  app: Express,
  overrides: { email?: string; workspaceName?: string; password?: string } = {},
): Promise<TestClient> {
  const email =
    overrides.email ??
    `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const agent = request.agent(app);

  const response = await agent.post('/api/auth/signup').send({
    email,
    password: overrides.password ?? TEST_PASSWORD,
    name: 'Test Owner',
    workspaceName: overrides.workspaceName ?? 'Test Workspace',
  });

  if (response.status !== 201) {
    throw new Error(`sign-up failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }

  const csrfToken = cookieValue(response, 'ubmp.csrf');
  if (csrfToken === undefined) throw new Error('sign-up did not set a CSRF cookie');

  return buildClient(agent, csrfToken, response.body as IdentityBody);
}

/** Signs an existing user in, returning a client bound to a fresh session. */
export async function signIn(
  app: Express,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<TestClient> {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').send({ email, password });

  if (response.status !== 200) {
    throw new Error(`sign-in failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }

  const csrfToken = cookieValue(response, 'ubmp.csrf');
  if (csrfToken === undefined) throw new Error('sign-in did not set a CSRF cookie');

  return buildClient(agent, csrfToken, response.body as IdentityBody);
}
