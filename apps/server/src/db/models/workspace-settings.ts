import { model, Schema, type Types } from 'mongoose';

/**
 * The assignment and escalation rules an Admin configures (F3.3, F3.5).
 *
 * Every timing is stored in seconds and is editable, because the requirements
 * insist thresholds be observable in seconds during a demonstration (Section 4
 * preamble, Q13). The demo workspace uses 30s; production defaults are minutes.
 */
export interface EscalationLevelSetting {
  target: 'assignee' | 'next_eligible' | 'backup' | 'manager';
  windowSeconds: number;
}

export interface WorkspaceSettingsDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;

  mode: 'round_robin';
  maxOpenLeadsPerEmployee: number;
  /** The first level's window. Kept separate so it reads as "the" window. */
  acknowledgementWindowSeconds: number;
  /** Levels after the assignee. Count and durations both configurable (F3.5). */
  escalationLevels: EscalationLevelSetting[];

  backupMembershipId: Types.ObjectId | null;
  managerMembershipId: Types.ObjectId | null;

  /** A lead untouched for this long joins the recovery queue (F3.7). */
  idleRecoveryMinutes: number;
  /** Escalations at or above this count join the recovery queue (Section 7). */
  recoveryMinEscalations: number;

  /** Where the round-robin left off. A value, not module state (F3.3). */
  roundRobinCursorMembershipId: Types.ObjectId | null;

  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_ESCALATION_LEVELS: EscalationLevelSetting[] = [
  { target: 'next_eligible', windowSeconds: 120 },
  { target: 'backup', windowSeconds: 180 },
  { target: 'manager', windowSeconds: 300 },
];

const settingsSchema = new Schema<WorkspaceSettingsDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, unique: true },

    mode: { type: String, required: true, enum: ['round_robin'], default: 'round_robin' },
    maxOpenLeadsPerEmployee: { type: Number, required: true, default: 5, min: 1 },
    acknowledgementWindowSeconds: { type: Number, required: true, default: 120, min: 5 },
    escalationLevels: {
      type: [
        new Schema<EscalationLevelSetting>(
          {
            target: { type: String, required: true },
            windowSeconds: { type: Number, required: true, min: 5 },
          },
          { _id: false },
        ),
      ],
      default: () => DEFAULT_ESCALATION_LEVELS,
    },

    backupMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },
    managerMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },

    idleRecoveryMinutes: { type: Number, required: true, default: 60, min: 1 },
    recoveryMinEscalations: { type: Number, required: true, default: 2, min: 1 },

    roundRobinCursorMembershipId: { type: Schema.Types.ObjectId, ref: 'Membership', default: null },

    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, minimize: false },
);

export const WorkspaceSettingsModel = model<WorkspaceSettingsDoc>(
  'WorkspaceSettings',
  settingsSchema,
);
