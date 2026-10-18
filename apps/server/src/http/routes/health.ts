import type { HealthResponse } from '@ubmp/shared';
import { Router } from 'express';

import { pingDatabase } from '../../db/mongoose.js';

export interface HealthRouterOptions {
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  /** Injected so the route can be tested without a database. */
  readonly dependencyStatus?: () => Promise<HealthResponse['dependencies']>;
  readonly uptimeSeconds?: () => number;
}

/**
 * `GET /api/health` pings MongoDB and reports whether the process and its
 * dependencies are healthy. It is unauthenticated on purpose: it is used by the
 * web app's startup check and by container orchestration, and it exposes no
 * workspace data.
 */
export function createHealthRouter(options: HealthRouterOptions): Router {
  const router = Router();

  const readDependencies =
    options.dependencyStatus ?? (async () => ({ database: await pingDatabase() }));
  const readUptime = options.uptimeSeconds ?? (() => process.uptime());

  router.get('/health', async (_req, res) => {
    const dependencies = await readDependencies();
    const allUp = Object.values(dependencies).every((status) => status === 'up');

    const body: HealthResponse = {
      status: allUp ? 'ok' : 'degraded',
      service: options.service,
      version: options.version,
      environment: options.environment,
      uptimeSeconds: Math.round(readUptime()),
      timestamp: new Date().toISOString(),
      dependencies,
    };

    // 200 even when degraded: the process is answering, and the body says which
    // dependency is down. A non-2xx here would make the web app treat a database
    // blip as "the API is gone".
    res.status(200).json(body);
  });

  return router;
}
