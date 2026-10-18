import { model, Schema, type Types } from 'mongoose';

/**
 * A person at a customer company (F2.1).
 *
 * A contact is shared across pipelines: the same person can hold opportunities
 * in two pipelines with different custom field sets, which is what F2.3
 * requires. That works because custom field *values* live on the record whose
 * definition names them, so a contact carries contact fields only.
 */
export interface ContactDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** `null` for an individual with no company (F2.1 allows it). */
  companyId: Types.ObjectId | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** Free-form labels, one of the filter criteria in F2.6. */
  tags: string[];
  ownerMembershipId: Types.ObjectId | null;
  customFields: Record<string, unknown>;
  /** I1.9: an opted-out contact cannot be messaged. Set in P7. */
  optedOutOfMessaging: boolean;
  /** Last note, message, call log, stage change or appointment (Section 7). */
  lastActivityAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<ContactDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null },
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, default: '', trim: true, maxlength: 100 },
    email: { type: String, default: null, trim: true, lowercase: true, maxlength: 320 },
    phone: { type: String, default: null, trim: true, maxlength: 40 },
    tags: { type: [String], default: [] },
    ownerMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    optedOutOfMessaging: { type: Boolean, default: false },
    lastActivityAt: { type: Date, default: null },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

// One index per filter criterion F2.6 names, all led by workspaceId so a query
// can never scan another tenant's documents (F1.6, Q9).
contactSchema.index({ workspaceId: 1, createdAt: -1 });
contactSchema.index({ workspaceId: 1, companyId: 1 });
contactSchema.index({ workspaceId: 1, ownerMembershipId: 1 });
contactSchema.index({ workspaceId: 1, tags: 1 });
contactSchema.index({ workspaceId: 1, email: 1 });
// Phone lookup is how an inbound message finds its contact (I1.5).
contactSchema.index({ workspaceId: 1, phone: 1 });
// Search by name. A text index rather than a regex scan, so several hundred
// records stay responsive (Q9).
contactSchema.index({ workspaceId: 1, firstName: 'text', lastName: 'text' });

export const ContactModel = model<ContactDoc>('Contact', contactSchema);

/** The display name, built the same way everywhere. */
export function contactDisplayName(contact: Pick<ContactDoc, 'firstName' | 'lastName'>): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}
