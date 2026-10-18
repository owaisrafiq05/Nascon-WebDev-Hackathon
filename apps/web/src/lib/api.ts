import { apiErrorResponseSchema, type FieldErrors } from '@ubmp/shared';
import type { z } from 'zod';

/**
 * The single way the web app talks to the API.
 *
 * Responsibilities kept here so no component repeats them:
 *   - send session cookies (`credentials: 'include'`)
 *   - turn a non-2xx into a typed `ApiError` carrying the server's message, hint
 *     and field errors, so every form can show a useful failure state (Q10)
 *   - validate the success body against the shared schema, so a contract change
 *     fails loudly instead of rendering `undefined`
 */

/** Empty in development: the Vite dev server proxies `/api` to the API process. */
const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;
  readonly fields: FieldErrors | undefined;
  readonly requestId: string | undefined;

  constructor(init: {
    code: string;
    status: number;
    message: string;
    hint?: string | undefined;
    fields?: FieldErrors | undefined;
    requestId?: string | undefined;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.hint = init.hint;
    this.fields = init.fields;
    this.requestId = init.requestId;
  }
}

/** Raised when the server answered but the body is not what the contract says. */
export class ApiContractError extends Error {
  constructor(path: string, issues: string) {
    super(`The response from ${path} did not match the expected shape: ${issues}`);
    this.name = 'ApiContractError';
  }
}

function toApiError(status: number, body: unknown, requestId: string | undefined): ApiError {
  const parsed = apiErrorResponseSchema.safeParse(body);

  if (!parsed.success) {
    // A proxy, a tunnel or a crash can answer with HTML or nothing at all.
    return new ApiError({
      code: 'INTERNAL',
      status,
      message: 'The server returned an unexpected response.',
      hint: 'Try again in a moment. If it keeps happening, the API may be down.',
      requestId,
    });
  }

  const fields = parsed.data.error.details?.['fields'];

  return new ApiError({
    code: parsed.data.error.code,
    status,
    message: parsed.data.error.message,
    hint: parsed.data.error.hint,
    fields: isFieldErrors(fields) ? fields : undefined,
    requestId: parsed.data.requestId ?? requestId,
  });
}

function isFieldErrors(value: unknown): value is FieldErrors {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  readonly body?: unknown;
}

export async function apiRequest<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  options: ApiRequestOptions = {},
): Promise<z.infer<TSchema>> {
  const { body, headers, ...rest } = options;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError({
      code: 'SERVICE_UNAVAILABLE',
      status: 0,
      message: 'The server could not be reached.',
      hint: 'Check that the API is running, then try again.',
    });
  }

  const requestId = response.headers.get('x-request-id') ?? undefined;
  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw toApiError(response.status, payload, requestId);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiContractError(path, parsed.error.issues.map((issue) => issue.message).join(', '));
  }

  return parsed.data;
}
