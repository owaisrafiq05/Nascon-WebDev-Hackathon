import { model, Schema, type Types } from 'mongoose';

/**
 * One employee's Google Calendar connection (I3.1, I3.2).
 *
 * Tokens are encrypted at rest and never leave the server. `status` turns to
 * `needs_reconnect` when Google refuses a refresh (revoked or expired consent),
 * which is what the interface shows (I3.2, I3.7).
 */
export const CALENDAR_STATUSES = ['connected', 'needs_reconnect'] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

export interface CalendarConnectionDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  membershipId: Types.ObjectId;
  googleEmail: string;
  calendarId: string;
  timeZone: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  status: CalendarStatus;
  lastError: string | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const calendarConnectionSchema = new Schema<CalendarConnectionDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    googleEmail: { type: String, required: true, maxlength: 320 },
    calendarId: { type: String, required: true, default: 'primary', maxlength: 320 },
    timeZone: { type: String, required: true, default: 'UTC', maxlength: 64 },
    refreshToken: { type: String, required: true },
    accessToken: { type: String, default: null },
    accessTokenExpiresAt: { type: Date, default: null },
    status: { type: String, required: true, enum: CALENDAR_STATUSES, default: 'connected' },
    lastError: { type: String, default: null, maxlength: 1_000 },
    lastSuccessAt: { type: Date, default: null },
  },
  { timestamps: true },
);

calendarConnectionSchema.index({ workspaceId: 1, membershipId: 1 }, { unique: true });

export const CalendarConnectionModel = model<CalendarConnectionDoc>(
  'CalendarConnection',
  calendarConnectionSchema,
);
