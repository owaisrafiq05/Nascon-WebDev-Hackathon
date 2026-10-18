import { Router } from 'express';
import { z } from 'zod';

import { MembershipModel } from '../../db/models/membership.js';
import { isValidTimeZone } from '../../services/calendar-service.js';
import {
  DASHBOARD_RANGES,
  DASHBOARD_TILES,
  dashboardFor,
} from '../../services/dashboard-service.js';
import { authOf, requireSession } from '../middleware/authenticate.js';

/** The operational dashboard (F5.1 - F5.5). */
export function createDashboardRouter(): Router {
  const router = Router();

  router.get('/dashboard', requireSession(), async (req, res) => {
    const query = z
      .object({
        range: z.enum(DASHBOARD_RANGES).default('today'),
        tz: z
          .string()
          .max(64)
          .refine(isValidTimeZone, 'is not a recognised time zone')
          .default('UTC'),
      })
      .parse(req.query);
    res.status(200).json(await dashboardFor(authOf(req), query.range, query.tz));
  });

  /** Remembered per member on the server, not in the browser (F5.5). */
  router.put('/dashboard/preferences', requireSession(), async (req, res) => {
    const { hiddenTiles } = z
      .object({ hiddenTiles: z.array(z.enum(DASHBOARD_TILES)).max(DASHBOARD_TILES.length) })
      .parse(req.body);
    const auth = authOf(req);
    const unique = [...new Set(hiddenTiles)];
    await MembershipModel.updateOne(
      { _id: auth.membershipId, workspaceId: auth.workspaceId },
      { $set: { dashboardHiddenTiles: unique } },
    );
    res.status(200).json({ hiddenTiles: unique });
  });

  return router;
}
