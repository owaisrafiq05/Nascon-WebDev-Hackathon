/**
 * A single error vocabulary shared by the server, the worker and the web app.
 *
 * Every failed mutation returns one of these codes plus a message written for the
 * person reading it, so the interface can say what went wrong and what to do next
 * (Q10). The HTTP status is derived from the code so that a route can never return
 * a status that disagrees with the code.
 */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_FAILED: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export function statusForErrorCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** Extra machine-readable context, for example the fields that failed validation. */
export type ErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /** What the user can do about it. Shown in the interface. */
  readonly hint?: string;
  readonly details?: ErrorDetails;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = statusForErrorCode(code);
    this.hint = options.hint;
    this.details = options.details;
  }

  /**
   * The shape sent to the browser. It never contains a stack trace, an internal
   * message or anything derived from a secret.
   */
  toResponseBody(requestId?: string): {
    error: { code: ErrorCode; message: string; hint?: string; details?: ErrorDetails };
    requestId?: string;
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint === undefined ? {} : { hint: this.hint }),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export const badRequest = (message: string, options?: AppErrorOptions): AppError =>
  new AppError(ERROR_CODES.BAD_REQUEST, message, options);

export const validationFailed = (message: string, options?: AppErrorOptions): AppError =>
  new AppError(ERROR_CODES.VALIDATION_FAILED, message, options);

export const unauthenticated = (
  message = 'You are not signed in.',
  options?: AppErrorOptions,
): AppError => new AppError(ERROR_CODES.UNAUTHENTICATED, message, options);

export const forbidden = (
  message = 'You do not have permission to do that.',
  options?: AppErrorOptions,
): AppError => new AppError(ERROR_CODES.FORBIDDEN, message, options);

/**
 * Used for records that are missing *and* for records that belong to another
 * workspace, so that a guessed identifier cannot be used to tell the two apart
 * (F1.6, Q2).
 */
export const notFound = (
  message = 'That record does not exist.',
  options?: AppErrorOptions,
): AppError => new AppError(ERROR_CODES.NOT_FOUND, message, options);

export const conflict = (message: string, options?: AppErrorOptions): AppError =>
  new AppError(ERROR_CODES.CONFLICT, message, options);

export const versionConflict = (
  message = 'Someone else changed this record while you were editing it.',
  options?: AppErrorOptions,
): AppError =>
  new AppError(ERROR_CODES.VERSION_CONFLICT, message, {
    hint: 'Reload the record and apply your change again.',
    ...options,
  });

export const upstreamFailed = (message: string, options?: AppErrorOptions): AppError =>
  new AppError(ERROR_CODES.UPSTREAM_FAILED, message, options);

export const internal = (
  message = 'Something went wrong on our side.',
  options?: AppErrorOptions,
): AppError => new AppError(ERROR_CODES.INTERNAL, message, options);
