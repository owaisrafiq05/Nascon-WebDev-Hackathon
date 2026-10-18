import { z } from 'zod';

import { ERROR_CODES } from './errors.js';

/**
 * The wire shape of a failed request. The server produces it from `AppError` and
 * the web app parses it with this schema, so the two cannot drift.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(Object.values(ERROR_CODES) as [string, ...string[]]),
    message: z.string(),
    hint: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  requestId: z.string().optional(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Field-level messages for a form, as sent under `details.fields`. */
export const fieldErrorsSchema = z.record(z.string(), z.string());
export type FieldErrors = z.infer<typeof fieldErrorsSchema>;
