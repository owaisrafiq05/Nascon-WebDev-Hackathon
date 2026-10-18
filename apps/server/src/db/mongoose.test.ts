import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectToDatabase, databaseStatus, disconnectFromDatabase } from './mongoose.js';

const logger = pino({ level: 'silent' });

let mongod: MongoMemoryServer;
let uri: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri('ubmp-test');
});

afterAll(async () => {
  await disconnectFromDatabase();
  await mongod.stop();
});

describe('databaseStatus', () => {
  it('maps the driver readyState onto the health vocabulary', () => {
    expect(databaseStatus(mongoose.ConnectionStates.connected)).toBe('up');
    expect(databaseStatus(mongoose.ConnectionStates.connecting)).toBe('connecting');
    expect(databaseStatus(mongoose.ConnectionStates.disconnected)).toBe('down');
    expect(databaseStatus(mongoose.ConnectionStates.uninitialized)).toBe('down');
  });
});

describe('connectToDatabase', () => {
  it('connects to a real MongoDB and reports the database as up (Q6)', async () => {
    await connectToDatabase({ uri, logger });

    expect(databaseStatus()).toBe('up');
    expect(mongoose.connection.name).toBe('ubmp-test');
  });

  it('keeps written data across a disconnect and reconnect (Q6)', async () => {
    const Probe = mongoose.model(
      'Probe',
      new mongoose.Schema({ key: { type: String, required: true } }),
    );

    await Probe.create({ key: 'survives-restart' });
    await disconnectFromDatabase();
    expect(databaseStatus()).toBe('down');

    await connectToDatabase({ uri, logger });
    const found = await Probe.findOne({ key: 'survives-restart' }).lean();

    expect(found).not.toBeNull();
  });

  it('fails fast on a URI that no server answers, instead of hanging', async () => {
    await disconnectFromDatabase();

    await expect(
      connectToDatabase({
        uri: 'mongodb://127.0.0.1:1/ubmp-nope',
        logger,
        serverSelectionTimeoutMs: 500,
      }),
    ).rejects.toThrow();

    // Leave the shared connection usable for any test that runs after this one.
    await connectToDatabase({ uri, logger });
  });
});
