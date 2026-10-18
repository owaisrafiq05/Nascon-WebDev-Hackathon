import { createServer } from 'node:http';
import { createRequire } from 'node:module';

import { loadServerConfig } from './config.js';
import { connectToDatabase, disconnectFromDatabase } from './db/mongoose.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { startOutboxRelay } from './realtime/outbox-relay.js';
import { createRealtimeHub } from './realtime/socket-server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

async function main(): Promise<void> {
  const config = loadServerConfig();
  const logger = createLogger(config);

  await connectToDatabase({ uri: config.mongoUri, logger });

  const app = createApp({ config, logger, version });
  const server = createServer(app);
  const hub = createRealtimeHub(server, { webOrigins: config.webOrigins, logger });
  const relay = startOutboxRelay(hub, { intervalMs: config.outboxRelayIntervalMs, logger });

  server.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'server listening');
  });

  // Finish in-flight requests, then release the database, so a redeploy or a
  // Ctrl-C does not abort a write half-way.
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    relay.stop();
    void hub.close();
    server.close(() => {
      void disconnectFromDatabase()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error({ err: error }, 'failed to close the database connection');
          process.exit(1);
        });
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  // The logger may not exist yet (a bad MONGODB_URI fails before it is built),
  // so this one path writes straight to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
