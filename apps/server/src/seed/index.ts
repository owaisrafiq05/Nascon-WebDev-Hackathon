import { loadServerConfig } from '../config.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/mongoose.js';
import { createLogger } from '../logger.js';

/**
 * `pnpm seed` — populates a development database with demo data.
 *
 * It connects for real and reports what it did, so the command is wired end to
 * end from P0 and does not need discovering later. There is nothing to insert
 * yet because no collection exists before P2.
 *
 * Grows with the phases that add the records it seeds:
 *   P2  two isolated demo workspaces, and a user at each role
 *   P3  pipelines, stages, custom field definitions, contacts, companies
 *   P4  leads with a source label, assignment rules, availability statuses
 *   P8  sample payments
 *   P12 short acknowledgement windows so a demo can be watched in seconds
 */
async function seed(): Promise<void> {
  const config = loadServerConfig();
  const logger = createLogger(config);

  if (config.isProduction) {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }

  await connectToDatabase({ uri: config.mongoUri, logger });

  const inserted = {
    workspaces: 0,
    users: 0,
    pipelines: 0,
    contacts: 0,
    leads: 0,
    payments: 0,
  };

  logger.info(inserted, 'seed complete: no collections exist before P2, so nothing was inserted');

  await disconnectFromDatabase();
}

seed()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
