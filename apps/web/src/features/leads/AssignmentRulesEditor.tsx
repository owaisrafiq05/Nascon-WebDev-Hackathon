import { PERMISSIONS } from '@ubmp/domain';
import { useEffect, useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Loading } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { useSession } from '../auth/session.js';
import {
  ESCALATION_TARGET_LABELS,
  useAssignmentRules,
  useAvailability,
  useUpdateAssignmentRules,
} from './leads-api.js';

interface Draft {
  maxOpen: string;
  ackWindow: string;
  levels: { target: string; windowSeconds: string }[];
  backup: string;
  manager: string;
  idleMinutes: string;
  minEscalations: string;
}

/** Thresholds, windows and the escalation ladder, configurable per workspace (F3.3, F3.5). */
export function AssignmentRulesEditor() {
  const session = useSession();
  const rules = useAssignmentRules();
  const availability = useAvailability();
  const update = useUpdateAssignmentRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const canEdit =
    session.data?.membership.permissions.includes(PERMISSIONS.ASSIGNMENT_RULES_MANAGE) ?? false;
  const members = availability.data?.members ?? [];

  useEffect(() => {
    const data = rules.data;
    if (data === undefined) return;
    setDraft({
      maxOpen: String(data.maxOpenLeadsPerEmployee),
      ackWindow: String(data.acknowledgementWindowSeconds),
      levels: data.escalationLevels.map((level) => ({
        target: level.target,
        windowSeconds: String(level.windowSeconds),
      })),
      backup: data.backupMembershipId ?? '',
      manager: data.managerMembershipId ?? '',
      idleMinutes: String(data.idleRecoveryMinutes),
      minEscalations: String(data.recoveryMinEscalations),
    });
  }, [rules.data]);

  if (rules.isPending || draft === null) {
    return rules.error === null ? (
      <Loading>Loading assignment rules…</Loading>
    ) : (
      <Alert error={rules.error} />
    );
  }
  if (rules.error !== null) return <Alert error={rules.error} />;

  const fieldErrors = update.error instanceof ApiError ? (update.error.fields ?? {}) : {};
  const patch = (changes: Partial<Draft>): void => {
    setDraft({ ...draft, ...changes });
  };

  function submit(): void {
    if (draft === null) return;
    const numbers = [
      draft.maxOpen,
      draft.ackWindow,
      draft.idleMinutes,
      draft.minEscalations,
      ...draft.levels.map((level) => level.windowSeconds),
    ].map(Number);
    if (numbers.some((n) => !Number.isInteger(n) || n < 1)) {
      setLocalError('Every number must be a whole number of at least 1.');
      return;
    }
    if (Number(draft.ackWindow) < 5 || draft.levels.some((l) => Number(l.windowSeconds) < 5)) {
      setLocalError('Acknowledgement windows must be at least 5 seconds.');
      return;
    }
    setLocalError(null);
    update.mutate({
      maxOpenLeadsPerEmployee: Number(draft.maxOpen),
      acknowledgementWindowSeconds: Number(draft.ackWindow),
      escalationLevels: draft.levels.map((level) => ({
        target: level.target,
        windowSeconds: Number(level.windowSeconds),
      })),
      backupMembershipId: draft.backup === '' ? null : draft.backup,
      managerMembershipId: draft.manager === '' ? null : draft.manager,
      idleRecoveryMinutes: Number(draft.idleMinutes),
      recoveryMinEscalations: Number(draft.minEscalations),
    });
  }

  const memberOptions = (
    <>
      <option value="">None</option>
      {members.map((member) => (
        <option key={member.membershipId} value={member.membershipId}>
          {member.email}
        </option>
      ))}
    </>
  );

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {!canEdit && (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          You can view these rules. Changing them needs the assignment rules permission.
        </p>
      )}
      <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Max open leads per employee"
            type="number"
            min={1}
            value={draft.maxOpen}
            onChange={(e) => {
              patch({ maxOpen: e.target.value });
            }}
            error={fieldErrors['maxOpenLeadsPerEmployee']}
          />
          <Field
            label="Acknowledgement window (seconds)"
            type="number"
            min={5}
            value={draft.ackWindow}
            onChange={(e) => {
              patch({ ackWindow: e.target.value });
            }}
            hint="Short values are useful for demos."
            error={fieldErrors['acknowledgementWindowSeconds']}
          />
          <Field
            label="Idle minutes before a lead is flagged for recovery"
            type="number"
            min={1}
            value={draft.idleMinutes}
            onChange={(e) => {
              patch({ idleMinutes: e.target.value });
            }}
          />
          <Field
            label="Escalations before a lead goes to the recovery queue"
            type="number"
            min={1}
            value={draft.minEscalations}
            onChange={(e) => {
              patch({ minEscalations: e.target.value });
            }}
          />
          <Select
            label="Backup employee"
            value={draft.backup}
            onChange={(e) => {
              patch({ backup: e.target.value });
            }}
          >
            {memberOptions}
          </Select>
          <Select
            label="Manager"
            value={draft.manager}
            onChange={(e) => {
              patch({ manager: e.target.value });
            }}
          >
            {memberOptions}
          </Select>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            Escalation levels
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            If a lead is not acknowledged in time, it moves to the next level in this order.
          </p>
          {draft.levels.length === 0 && (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">No levels set.</p>
          )}
          <ol className="mt-2 flex flex-col gap-2">
            {draft.levels.map((level, index) => (
              <li key={index} className="flex flex-wrap items-end gap-2">
                <span className="pb-2 text-sm font-medium">Level {index + 1}</span>
                <Select
                  label={`Level ${String(index + 1)} target`}
                  value={level.target}
                  onChange={(e) => {
                    patch({
                      levels: draft.levels.map((l, i) =>
                        i === index ? { ...l, target: e.target.value } : l,
                      ),
                    });
                  }}
                >
                  {Object.entries(ESCALATION_TARGET_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                <Field
                  label={`Level ${String(index + 1)} window (seconds)`}
                  type="number"
                  min={5}
                  value={level.windowSeconds}
                  onChange={(e) => {
                    patch({
                      levels: draft.levels.map((l, i) =>
                        i === index ? { ...l, windowSeconds: e.target.value } : l,
                      ),
                    });
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Remove level ${String(index + 1)}`}
                  onClick={() => {
                    patch({ levels: draft.levels.filter((_, i) => i !== index) });
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
          <div className="mt-2">
            <Button
              type="button"
              variant="secondary"
              disabled={draft.levels.length >= 10}
              onClick={() => {
                patch({
                  levels: [...draft.levels, { target: 'next_eligible', windowSeconds: '60' }],
                });
              }}
            >
              Add level
            </Button>
          </div>
        </div>
      </fieldset>

      <div aria-live="polite" className="flex flex-col gap-2">
        {localError !== null && <Alert error={new Error(localError)} />}
        <Alert error={update.error} />
        {update.isSuccess && <Notice>Assignment rules saved.</Notice>}
      </div>
      {canEdit && (
        <div>
          <Button type="submit" busy={update.isPending} busyLabel="Saving…">
            Save rules
          </Button>
        </div>
      )}
    </form>
  );
}
