import { describe, expect, it } from 'vitest';

import {
  AppError,
  ERROR_CODES,
  forbidden,
  isAppError,
  notFound,
  statusForErrorCode,
  versionConflict,
} from './errors.js';

describe('AppError', () => {
  it('derives the HTTP status from the code', () => {
    expect(forbidden().status).toBe(403);
    expect(notFound().status).toBe(404);
    expect(versionConflict().status).toBe(409);
  });

  it('maps every declared code to a status', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(statusForErrorCode(code)).toBeGreaterThanOrEqual(400);
    }
  });

  it('is recognised by isAppError but a plain Error is not', () => {
    expect(isAppError(forbidden())).toBe(true);
    expect(isAppError(new Error('boom'))).toBe(false);
    expect(isAppError('boom')).toBe(false);
  });

  it('never leaks the stack or the cause into the response body', () => {
    const error = new AppError(ERROR_CODES.INTERNAL, 'Something went wrong on our side.', {
      cause: new Error('mongodb://user:password@host/db refused the connection'),
    });

    const body = JSON.stringify(error.toResponseBody('req-1'));

    expect(body).not.toContain('password');
    expect(body).not.toContain('refused');
    expect(JSON.parse(body)).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side.' },
      requestId: 'req-1',
    });
  });

  it('includes the hint and details when they are given', () => {
    const error = versionConflict();
    expect(error.toResponseBody().error.hint).toBe(
      'Reload the record and apply your change again.',
    );
  });

  it('omits the requestId when it is not known', () => {
    expect(notFound().toResponseBody()).not.toHaveProperty('requestId');
  });

  it('uses NOT_FOUND for another workspace, so identifiers cannot be probed', () => {
    // F1.6 / Q2: "no such record" and "not yours" must be indistinguishable.
    expect(notFound().code).toBe(ERROR_CODES.NOT_FOUND);
    expect(notFound().message).not.toMatch(/workspace|permission|forbidden/i);
  });
});
