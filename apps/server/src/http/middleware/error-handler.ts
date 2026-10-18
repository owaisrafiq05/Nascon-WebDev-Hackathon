import { AppError, ERROR_CODES, internal, isAppError, validationFailed } from '@ubmp/shared';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import type { Logger } from '../../logger.js';

/**
 * Converts a Zod failure into the field-level detail the forms display, without
 * echoing the submitted values back (they may contain anything the user typed).
 */
function fromZodError(error: ZodError): AppError {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(body)';
    fieldErrors[path] ??= issue.message;
  }

  return validationFailed('Some of the information you entered is not valid.', {
    hint: 'Correct the highlighted fields and try again.',
    details: { fields: fieldErrors },
  });
}

/**
 * MongoDB reports a unique-index violation as error 11000. It means the caller
 * asked for something that already exists, which is a conflict rather than a
 * server fault, so it is mapped centrally here instead of each service
 * remembering to catch it.
 */
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/** `express.json()` raises this when the body is malformed or too large. */
function isBodyParserError(error: unknown): error is Error & { status: number; type?: string } {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'type' in error
  );
}

function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) return fromZodError(error);

  if (isDuplicateKeyError(error)) {
    // The duplicated value is not echoed back: it came from the caller, and
    // the index name would expose the schema.
    return new AppError(ERROR_CODES.CONFLICT, 'That already exists.', {
      hint: 'Use a different name, and try again.',
      cause: error,
    });
  }

  if (isBodyParserError(error)) {
    const tooLarge = error.status === 413;
    return new AppError(
      ERROR_CODES.BAD_REQUEST,
      tooLarge ? 'That request body is too large.' : 'That request body is not valid.',
      {
        hint: tooLarge ? 'Send less data in one request.' : 'Send a well-formed JSON body.',
        cause: error,
      },
    );
  }

  return internal(undefined, { cause: error });
}

/**
 * The single place an error becomes an HTTP response. Unexpected errors are
 * logged in full on the server and reported to the client as a generic message,
 * so an internal detail or a connection string never reaches the browser.
 */
export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = toAppError(error);

    if (appError.status >= 500) {
      logger.error({ err: error, requestId: req.id, path: req.path }, 'unhandled request failure');
    } else {
      logger.warn({ code: appError.code, requestId: req.id, path: req.path }, 'request rejected');
    }

    res.status(appError.status).json(appError.toResponseBody(req.id));
  };
}
