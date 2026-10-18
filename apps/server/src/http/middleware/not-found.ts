import { notFound } from '@ubmp/shared';
import type { NextFunction, Request, Response } from 'express';

/** Turns an unmatched route into the same error shape every other failure uses. */
export function notFoundHandler() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(
      notFound(`No route matches ${req.method} ${req.path}.`, {
        hint: 'Check the method and the path.',
      }),
    );
  };
}
