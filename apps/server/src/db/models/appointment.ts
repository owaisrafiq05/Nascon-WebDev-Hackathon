import { model, Schema, type Types } from 'mongoose';

/**
 * "A calendar event created from the platform and linked to a contact or
 * opportunity" (Section 7, I3.3 - I3.6).
 *
 * Times are stored as UTC instants plus the IANA zone they were booked in, so
 * the moment is unambiguous and the original wall-clock time can still be
 * shown (I3.5).
 */
export const APPOINTMENT_STATUSES = ['scheduled', 'cancelled'] as const;

export interface AppointmentDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  contactId: Types.ObjectId;
  opportunityId: Types.ObjectId | null;
  employeeMembershipId: Types.ObjectId;
  bookedByMembershipId: Types.ObjectId;
  title: string;
  notes: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  status: (typeof APPOINTMENT_STATUSES)[number];
  googleEventId: string | null;
  googleEventLink: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const appointmentSchema = new Schema<AppointmentDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    opportunityId: { type: Schema.Types.ObjectId, ref: 'Opportunity', default: null },
    employeeMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    bookedByMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    title: { type: String, required: true, maxlength: 200 },
    notes: { type: String, default: '', maxlength: 2_000 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    timeZone: { type: String, required: true, maxlength: 64 },
    status: { type: String, required: true, enum: APPOINTMENT_STATUSES, default: 'scheduled' },
    googleEventId: { type: String, default: null, maxlength: 1_024 },
    googleEventLink: { type: String, default: null, maxlength: 2_000 },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

appointmentSchema.index({ workspaceId: 1, contactId: 1, startsAt: -1 });
appointmentSchema.index({ workspaceId: 1, employeeMembershipId: 1, startsAt: 1 });
appointmentSchema.index({ workspaceId: 1, status: 1, startsAt: 1 });

export const AppointmentModel = model<AppointmentDoc>('Appointment', appointmentSchema);
