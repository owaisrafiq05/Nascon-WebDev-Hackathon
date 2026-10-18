import { z } from 'zod';

/**
 * The health contract is declared once and reused by the server (to build the
 * response) and the web app (to parse it), so the two can never drift apart.
 */
export const healthStatusSchema = z.enum(['ok', 'degraded']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const dependencyStatusSchema = z.enum(['up', 'down', 'connecting']);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  service: z.string(),
  version: z.string(),
  environment: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
  dependencies: z.object({
    database: dependencyStatusSchema,
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
