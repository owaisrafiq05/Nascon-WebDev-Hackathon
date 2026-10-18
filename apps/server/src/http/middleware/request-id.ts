import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates a log line, an error response and an audit entry. */
      id: string;
    }
  }
}

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Gives every request an id that is echoed to the client and attached to its log
 * lines, so a user-reported error can be traced to a single request (Q10).
 *
 * An inbound id is only trusted for correlation if it looks like one; otherwise a
 * caller could inject arbitrary text into the logs.
 */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.get(REQUEST_ID_HEADER);
    req.id = supplied !== undefined && /^[\w-]{1,64}$/.test(supplied) ? supplied : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, req.id);
    next();
  };
}
