import { z } from 'zod';

/**
 * Configuration is read from the environment and validated once at startup, so a
 * missing or malformed variable stops the process with a readable message instead
 * of surfacing as a confusing failure later (Q13).
 */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(processName: string, issues: readonly string[]) {
    super(
      `Invalid environment for "${processName}":\n` +
        issues.map((issue) => `  - ${issue}`).join('\n') +
        '\n\nCopy .env.example to .env and fill in the missing values.',
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parses `source` with `schema`.
 *
 * Variable *values* are never included in the error, because the environment holds
 * API keys and signing secrets (I5.3). Only names and the reason are reported.
 *
 * `source` is required rather than defaulting to `process.env`: this package is
 * also bundled for the browser, where `process` does not exist. The Node
 * processes pass `process.env` from their own `config.ts`.
 */
export function loadEnv<T extends z.ZodType>(
  processName: string,
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${name}: ${issue.message}`;
  });

  throw new EnvValidationError(processName, issues);
}

/** `NODE_ENV`, with the same meaning in every process. */
export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const logLevelSchema = z
  .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  .default('info');

/** A non-empty connection string. The driver validates the rest when it connects. */
export const mongoUriSchema = z
  .string()
  .min(1, 'is required')
  .refine(
    (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
    'must start with mongodb:// or mongodb+srv://',
  );

/**
 * Parses a comma-separated allow-list, for example `CORS` origins. Empty entries
 * are dropped so a trailing comma cannot widen the list to `""`.
 */
export const commaSeparatedList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

/** Shows only the last 4 characters of a secret, for display in the UI (I5.3). */
export function maskSecret(value: string | undefined, visible = 4): string {
  if (!value) return 'not set';
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(8, value.length - visible))}${value.slice(-visible)}`;
}
