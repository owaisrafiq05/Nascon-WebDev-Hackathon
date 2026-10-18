import { healthResponseSchema } from '@ubmp/shared';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../test/harness.js';
import { createApp } from './app.js';

const silentLogger = pino({ level: 'silent' });

const config = testConfig({ mongoUri: 'mongodb://localhost:27017/ubmp-test' });

const app = createApp({ config, logger: silentLogger, version: '0.0.0-test' });

describe('GET /api/health', () => {
  it('answers with a body that matches the shared health contract', async () => {
    const response = await request(app).get('/api/health').expect(200);

    const parsed = healthResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(response.body.service).toBe('ubmp-server');
    expect(response.body.environment).toBe('test');
  });

  it('reports degraded, not a 5xx, when the database is unreachable', async () => {
    // No database is connected in this test, so the dependency is down.
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.dependencies.database).toBe('down');
    expect(response.body.status).toBe('degraded');
  });

  it('echoes a request id so a failure can be traced', async () => {
    const response = await request(app).get('/api/health').expect(200);

    expect(response.headers['x-request-id']).toMatch(/^[\w-]{1,64}$/);
  });
});

describe('security middleware', () => {
  it('sets the Helmet headers', async () => {
    const response = await request(app).get('/api/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
  });

  it('does not advertise Express', async () => {
    const response = await request(app).get('/api/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows an origin on the allow-list', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('refuses an origin that is not on the allow-list', async () => {
    const response = await request(app).get('/api/health').set('Origin', 'http://evil.example');

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error handling', () => {
  it('returns the shared error shape for an unknown route', async () => {
    const response = await request(app).get('/api/does-not-exist').expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toContain('/api/does-not-exist');
    expect(response.body.requestId).toBeDefined();
  });

  it('rejects a malformed JSON body with a message a user can act on', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);

    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.error.hint).toBeDefined();
  });

  it('never leaks a stack trace or an internal message for an unexpected error', async () => {
    const appWithFailure = express();
    appWithFailure.get('/boom', () => {
      throw new Error('connection string mongodb://user:hunter2@db failed');
    });
    // Reuse the production error handler on a throwaway app.
    const { errorHandler } = await import('./middleware/error-handler.js');
    appWithFailure.use(errorHandler(silentLogger));

    const response = await request(appWithFailure).get('/boom').expect(500);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('at ');
    expect(response.body.error.code).toBe('INTERNAL');
  });
});
