import { notFound } from '@ubmp/shared';
import type { Request } from 'express';

/**
 * Reads a required path parameter.
 *
 * Express types `req.params` values as `string | string[] | undefined`, because
 * a pattern can repeat. Every route here expects exactly one value, so anything
 * else is treated as a record that does not exist rather than a validation
 * failure: a caller probing identifiers should not be able to tell "that is
 * malformed" from "that is not yours" (F1.6, Q2).
 */
export function requireParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];

  if (typeof value !== 'string' || value === '') {
    throw notFound('That record does not exist.');
  }

  return value;
}
