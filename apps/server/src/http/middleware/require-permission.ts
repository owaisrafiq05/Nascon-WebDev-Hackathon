import { hasPermission, type Permission } from '@ubmp/domain';
import { forbidden } from '@ubmp/shared';
import type { NextFunction, Request, Response } from 'express';

import { authOf } from './authenticate.js';

/**
 * Server-side permission enforcement (F1.5, Q2).
 *
 * Hiding a button is not protection: every endpoint that needs a permission is
 * wrapped in this, and sensitive services check again on their own, so a direct
 * API call by an unauthorised user is refused regardless of what the interface
 * offered.
 *
 * The check is on a permission, never on a base level or a role name, so a
 * workspace that invents a "Manager" set gets the access it configured (F1.3).
 */
export function requirePermission(...permissions: readonly Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = authOf(req);

    const missing = permissions.filter(
      (permission) => !hasPermission(auth.permissions, permission),
    );

    if (missing.length > 0) {
      next(
        forbidden('You do not have permission to do that.', {
          // Naming the permission is safe and makes the message actionable: it
          // reveals what the caller lacks, not anything about the data.
          hint: 'Ask an Owner or Admin to grant it to you.',
          details: { requiredPermissions: missing },
        }),
      );
      return;
    }

    next();
  };
}
