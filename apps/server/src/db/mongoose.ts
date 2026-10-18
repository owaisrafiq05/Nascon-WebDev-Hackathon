import type { DependencyStatus } from '@ubmp/shared';
import mongoose from 'mongoose';

import type { Logger } from '../logger.js';

/**
 * All data lives in MongoDB and survives a restart (Q6). The connection is owned
 * here; no other module calls `mongoose.connect`.
 */
export interface ConnectOptions {
  readonly uri: string;
  readonly logger: Logger;
  /** Fail fast in development instead of retrying a URI that will never work. */
  readonly serverSelectionTimeoutMs?: number;
}

export async function connectToDatabase({
  uri,
  logger,
  serverSelectionTimeoutMs = 10_000,
}: ConnectOptions): Promise<typeof mongoose> {
  // Reject writes that reference a field no schema declares, instead of silently
  // dropping them.
  mongoose.set('strictQuery', true);

  mongoose.connection.on('disconnected', () => {
    logger.warn('database disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('database reconnected');
  });
  mongoose.connection.on('error', (error: unknown) => {
    logger.error({ err: error }, 'database connection error');
  });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: serverSelectionTimeoutMs });
  logger.info({ database: mongoose.connection.name }, 'database connected');

  return mongoose;
}

export async function disconnectFromDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/**
 * Maps the driver's numeric readyState onto the vocabulary the health endpoint
 * reports, so the mapping exists in exactly one place.
 */
export function databaseStatus(
  readyState: mongoose.ConnectionStates = mongoose.connection.readyState,
): DependencyStatus {
  // Every state is listed rather than falling back to a default, so a new driver
  // state fails the build instead of being silently reported as "down".
  switch (readyState) {
    case mongoose.ConnectionStates.connected:
      return 'up';
    case mongoose.ConnectionStates.connecting:
    case mongoose.ConnectionStates.disconnecting:
      return 'connecting';
    case mongoose.ConnectionStates.disconnected:
    case mongoose.ConnectionStates.uninitialized:
      return 'down';
  }
}
