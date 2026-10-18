import { healthResponseSchema } from '@ubmp/shared';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectToDatabase, disconnectFromDatabase } from '../db/mongoose.js';
import { testConfig } from '../test/harness.js';
import { createApp } from './app.js';

/**
 * Exercises `GET /api/health` against a real MongoDB, so the endpoint's ping is
 * tested rather than mocked (Q6).
 */
const logger = pino({ level: 'silent' });

let mongod: MongoMemoryServer;

const config = testConfig();

const app = createApp({ config, logger, version: '0.0.0-test' });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectToDatabase({ uri: mongod.getUri('ubmp-health'), logger });
});

afterAll(async () => {
  await disconnectFromDatabase();
  await mongod.stop();
});

describe('GET /api/health against a real MongoDB', () => {
  it('reports ok with the database up', async () => {
    const response = await request(app).get('/api/health').expect(200);

    expect(healthResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.dependencies.database).toBe('up');
    expect(response.body.status).toBe('ok');
  });

  it('reports a non-negative uptime and a parseable timestamp', async () => {
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });

  it('flips to degraded once the database goes away, still answering 200', async () => {
    await disconnectFromDatabase();

    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.dependencies.database).toBe('down');
    expect(response.body.status).toBe('degraded');

    // Restore for any test that runs after this one.
    await connectToDatabase({ uri: mongod.getUri('ubmp-health'), logger });
  });
});
