import { ALL_PERMISSIONS } from '@ubmp/domain';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MembershipModel } from '../../db/models/membership.js';
import { PermissionSetModel } from '../../db/models/permission-set.js';
import { SessionModel } from '../../db/models/session.js';
import { UserModel } from '../../db/models/user.js';
import { WorkspaceModel } from '../../db/models/workspace.js';
import { GENERIC_LOGIN_FAILURE } from '../../services/auth-service.js';
import { hashSessionToken } from '../../services/session-service.js';
import {
  cookieValue,
  createTestApp,
  resetDatabase,
  signIn,
  signUpOwner,
  startTestDatabase,
  stopTestDatabase,
  testConfig,
  TEST_PASSWORD,
} from '../../test/harness.js';
import { CSRF_HEADER } from '../middleware/authenticate.js';

let app: Express;

beforeAll(async () => {
  await startTestDatabase();
  app = createTestApp();
}, 180_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await resetDatabase();
});

const signUpBody = {
  email: 'ada@example.com',
  password: TEST_PASSWORD,
  name: 'Ada Lovelace',
  workspaceName: 'Analytical Engines',
};

// ---------------------------------------------------------------------------
// Sign up (F1.1)
// ---------------------------------------------------------------------------

describe('POST /api/auth/signup', () => {
  it('creates the user, the workspace and an Owner membership', async () => {
    const response = await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    expect(response.body.user.email).toBe('ada@example.com');
    expect(response.body.workspace.name).toBe('Analytical Engines');
    expect(response.body.membership.baseLevel).toBe('owner');

    const membership = await MembershipModel.findOne({}).lean();
    expect(membership?.baseLevel).toBe('owner');
    expect(await WorkspaceModel.countDocuments()).toBe(1);
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('makes the first user an Owner holding every permission (F1.1)', async () => {
    const response = await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    expect(response.body.membership.permissions).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('seeds the workspace default permission sets (F1.3)', async () => {
    await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    const sets = await PermissionSetModel.find({}).lean();
    expect(sets.map((set) => set.name).sort()).toEqual(['Administrator', 'Manager', 'Member']);
  });

  it('sets an httpOnly SameSite=Lax session cookie with an expiry (Q1)', async () => {
    const response = await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    const headers = response.headers['set-cookie'] as unknown as string[];
    const sessionCookie = headers.find((header) => header.startsWith('ubmp.sid='));

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toMatch(/Max-Age=\d+/);
  });

  it('does not set Secure outside production, so http://localhost works', async () => {
    const response = await request(app).post('/api/auth/signup').send(signUpBody);
    const headers = response.headers['set-cookie'] as unknown as string[];

    expect(headers.find((header) => header.startsWith('ubmp.sid='))).not.toContain('Secure');
  });

  it('sets Secure in production', async () => {
    const productionApp = createTestApp(testConfig({ isProduction: true, env: 'production' }));
    const response = await request(productionApp)
      .post('/api/auth/signup')
      .send({ ...signUpBody, email: 'prod@example.com' });

    const headers = response.headers['set-cookie'] as unknown as string[];
    expect(headers.find((header) => header.startsWith('ubmp.sid='))).toContain('Secure');
  });

  it('stores a password hash, never the password (Q1)', async () => {
    await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    const user = await UserModel.findOne({}).select('+passwordHash').lean();

    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain(TEST_PASSWORD);
  });

  it('never returns the password hash', async () => {
    const response = await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    expect(JSON.stringify(response.body)).not.toContain('argon2');
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
  });

  it('stores only a digest of the session token, not the token (Q1)', async () => {
    const response = await request(app).post('/api/auth/signup').send(signUpBody).expect(201);
    const token = cookieValue(response, 'ubmp.sid');

    const stored = await SessionModel.findOne({}).lean();

    expect(stored?.tokenHash).toBe(hashSessionToken(token!));
    expect(JSON.stringify(stored)).not.toContain(token!);
  });

  it('refuses a second account for the same email', async () => {
    await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    const response = await request(app).post('/api/auth/signup').send(signUpBody).expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('treats email as case-insensitive, so one person cannot register twice', async () => {
    await request(app).post('/api/auth/signup').send(signUpBody).expect(201);

    await request(app)
      .post('/api/auth/signup')
      .send({ ...signUpBody, email: 'ADA@Example.com' })
      .expect(409);
  });

  it('rejects a password below the minimum length, with the field named (Q3, Q10)', async () => {
    const response = await request(app)
      .post('/api/auth/signup')
      .send({ ...signUpBody, password: 'short' })
      .expect(422);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details.fields.password).toContain('at least');
  });

  it('rejects a malformed email', async () => {
    const response = await request(app)
      .post('/api/auth/signup')
      .send({ ...signUpBody, email: 'not-an-email' })
      .expect(422);

    expect(response.body.error.details.fields.email).toBeDefined();
  });

  it('rejects a missing workspace name', async () => {
    await request(app)
      .post('/api/auth/signup')
      .send({ ...signUpBody, workspaceName: '   ' })
      .expect(422);
  });

  it('leaves nothing behind when the transaction cannot complete (F1.1)', async () => {
    // A duplicate email is refused before any document is written.
    await request(app).post('/api/auth/signup').send(signUpBody).expect(201);
    await request(app).post('/api/auth/signup').send(signUpBody).expect(409);

    expect(await UserModel.countDocuments()).toBe(1);
    expect(await WorkspaceModel.countDocuments()).toBe(1);
    expect(await MembershipModel.countDocuments()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

describe('POST /api/auth/login', () => {
  it('signs an existing user in and sets a session cookie', async () => {
    await signUpOwner(app, { email: 'grace@example.com' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'grace@example.com', password: TEST_PASSWORD })
      .expect(200);

    expect(cookieValue(response, 'ubmp.sid')).toBeTruthy();
    expect(response.body.membership.baseLevel).toBe('owner');
  });

  it('accepts the email in any case', async () => {
    await signUpOwner(app, { email: 'grace@example.com' });

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'GRACE@Example.COM', password: TEST_PASSWORD })
      .expect(200);
  });

  it('gives one generic message for a wrong password (Q1)', async () => {
    await signUpOwner(app, { email: 'grace@example.com' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'grace@example.com', password: 'wrong-password-entirely' })
      .expect(401);

    expect(response.body.error.message).toBe(GENERIC_LOGIN_FAILURE);
  });

  it('gives the same message for an unknown account, so addresses cannot be probed', async () => {
    await signUpOwner(app, { email: 'grace@example.com' });

    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: TEST_PASSWORD })
      .expect(401);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'grace@example.com', password: 'wrong-password-entirely' })
      .expect(401);

    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
    expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
    expect(unknown.status).toBe(wrongPassword.status);
  });

  it('never says whether the account exists or is disabled', async () => {
    await signUpOwner(app, { email: 'grace@example.com' });
    await UserModel.updateOne({ email: 'grace@example.com' }, { $set: { status: 'disabled' } });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'grace@example.com', password: TEST_PASSWORD })
      .expect(401);

    expect(response.body.error.message).toBe(GENERIC_LOGIN_FAILURE);
    expect(response.body.error.message).not.toMatch(/disabled|exist|unknown|found/i);
  });

  it('does not set a session cookie on a failed attempt', async () => {
    await signUpOwner(app, { email: 'grace@example.com' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'grace@example.com', password: 'wrong-password-entirely' })
      .expect(401);

    expect(cookieValue(response, 'ubmp.sid')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Login rate limiting (Q1)
// ---------------------------------------------------------------------------

describe('login rate limiting', () => {
  it('refuses further attempts once the limit is reached', async () => {
    const limited = createTestApp(
      testConfig({ loginRateLimit: { max: 3, windowMs: 15 * 60 * 1_000 } }),
    );
    await signUpOwner(limited, { email: 'target@example.com' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(limited)
        .post('/api/auth/login')
        .send({ email: 'target@example.com', password: `wrong-${String(attempt)}-password` })
        .expect(401);
    }

    const blocked = await request(limited)
      .post('/api/auth/login')
      .send({ email: 'target@example.com', password: 'wrong-again-password' })
      .expect(429);

    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.body.error.hint).toContain('minutes');
  });

  it('blocks the correct password too, so the limit cannot be outlasted', async () => {
    const limited = createTestApp(
      testConfig({ loginRateLimit: { max: 2, windowMs: 15 * 60 * 1_000 } }),
    );
    await signUpOwner(limited, { email: 'target2@example.com' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(limited)
        .post('/api/auth/login')
        .send({ email: 'target2@example.com', password: `wrong-${String(attempt)}-password` })
        .expect(401);
    }

    await request(limited)
      .post('/api/auth/login')
      .send({ email: 'target2@example.com', password: TEST_PASSWORD })
      .expect(429);
  });

  it('counts per email, so one address cannot lock out another', async () => {
    const limited = createTestApp(
      testConfig({ loginRateLimit: { max: 2, windowMs: 15 * 60 * 1_000 } }),
    );
    await signUpOwner(limited, { email: 'victim@example.com' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(limited)
        .post('/api/auth/login')
        .send({ email: 'attacked@example.com', password: `wrong-${String(attempt)}-password` });
    }

    // A different address from the same host still gets its own allowance.
    await request(limited)
      .post('/api/auth/login')
      .send({ email: 'victim@example.com', password: TEST_PASSWORD })
      .expect(200);
  });
});

// ---------------------------------------------------------------------------
// Session, /me and sign out
// ---------------------------------------------------------------------------

describe('GET /api/auth/me', () => {
  it('returns the identity for a signed-in member, which keeps a refresh signed in (F1.1)', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    const response = await owner.get('/api/auth/me').expect(200);

    expect(response.body.user.email).toBe('ada@example.com');
    expect(response.body.membership.baseLevel).toBe('owner');
  });

  it('refuses an anonymous caller', async () => {
    const response = await request(app).get('/api/auth/me').expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a forged session cookie', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'ubmp.sid=not-a-real-session-token')
      .expect(401);
  });

  it('refuses a session that has expired (Q1)', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    await SessionModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1_000) } });

    await owner.get('/api/auth/me').expect(401);
  });

  it('refuses a session that was revoked server-side (Q1)', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    await SessionModel.updateOne({}, { $set: { revokedAt: new Date() } });

    await owner.get('/api/auth/me').expect(401);
  });

  it('refuses a session whose membership has been removed', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    await MembershipModel.deleteMany({});

    await owner.get('/api/auth/me').expect(401);
  });

  it('reflects a permission change on the next request, not at expiry', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    // Demoting the Owner to a User with no sets leaves them with nothing.
    await MembershipModel.updateOne(
      { _id: owner.membershipId },
      { $set: { baseLevel: 'user', permissionSetIds: [], extraPermissions: [] } },
    );

    const response = await owner.get('/api/auth/me').expect(200);

    expect(response.body.membership.baseLevel).toBe('user');
    expect(response.body.membership.permissions).toEqual([]);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session server-side, so a copied cookie is dead too (Q1)', async () => {
    // Signed up by hand so the raw cookie token is available to replay.
    const signUp = await request(app).post('/api/auth/signup').send(signUpBody).expect(201);
    const token = cookieValue(signUp, 'ubmp.sid');
    const csrf = cookieValue(signUp, 'ubmp.csrf');
    expect(token).toBeTruthy();

    // The copied cookie works before the sign-out.
    await request(app).get('/api/auth/me').set('Cookie', `ubmp.sid=${token!}`).expect(200);

    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `ubmp.sid=${token!}`)
      .set(CSRF_HEADER, csrf!)
      .expect(204);

    const session = await SessionModel.findOne({}).lean();
    expect(session?.revokedAt).not.toBeNull();

    // The same cookie value, replayed by a different client, is now refused.
    await request(app).get('/api/auth/me').set('Cookie', `ubmp.sid=${token!}`).expect(401);
  });

  it('clears both cookies', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    const response = await owner.post('/api/auth/logout').expect(204);
    const headers = response.headers['set-cookie'] as unknown as string[];

    expect(headers.some((header) => header.startsWith('ubmp.sid=;'))).toBe(true);
    expect(headers.some((header) => header.startsWith('ubmp.csrf=;'))).toBe(true);
  });

  it('leaves the caller signed out', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    await owner.post('/api/auth/logout').expect(204);
    await owner.get('/api/auth/me').expect(401);
  });

  it('succeeds for a caller who was not signed in', async () => {
    await request(app).post('/api/auth/logout').expect(204);
  });

  it('can sign in again afterwards', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });
    await owner.post('/api/auth/logout').expect(204);

    const again = await signIn(app, 'ada@example.com');
    await again.get('/api/auth/me').expect(200);
  });
});

// ---------------------------------------------------------------------------
// CSRF (Q3)
// ---------------------------------------------------------------------------

describe('CSRF protection', () => {
  it('refuses a cookie-authenticated POST with no CSRF token', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    const response = await owner.agent.post('/api/auth/logout').send({}).expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.message).toContain('security token');
  });

  it('refuses a POST carrying the wrong CSRF token', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    await owner.agent
      .post('/api/auth/logout')
      .set(CSRF_HEADER, 'this-is-not-the-right-token')
      .send({})
      .expect(403);
  });

  it('accepts a POST carrying the token from the session', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    await owner.post('/api/auth/logout').expect(204);
  });

  it('does not require a token when there is no session to forge against', async () => {
    // Sign-in and sign-up are reachable without one.
    await request(app).post('/api/auth/signup').send(signUpBody).expect(201);
  });

  it('does not require a token for a safe method', async () => {
    const owner = await signUpOwner(app, { email: 'ada@example.com' });

    await owner.agent.get('/api/auth/me').expect(200);
  });

  it('ties the token to the session, so another member token does not work', async () => {
    const first = await signUpOwner(app, { email: 'one@example.com' });
    const second = await signUpOwner(app, { email: 'two@example.com' });

    await first.agent
      .post('/api/auth/logout')
      .set(CSRF_HEADER, second.csrfToken)
      .send({})
      .expect(403);
  });

  it('publishes the token in a readable cookie for the web app', async () => {
    const response = await request(app).post('/api/auth/signup').send(signUpBody).expect(201);
    const headers = response.headers['set-cookie'] as unknown as string[];
    const csrfCookie = headers.find((header) => header.startsWith('ubmp.csrf='));

    expect(csrfCookie).toBeDefined();
    // The page must be able to read it to echo it back.
    expect(csrfCookie).not.toContain('HttpOnly');
  });
});
