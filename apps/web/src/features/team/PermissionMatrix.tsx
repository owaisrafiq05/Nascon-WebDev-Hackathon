import { PERMISSIONS, type BaseLevel } from '@ubmp/domain';
import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { useChangePermissions, type Member, type PermissionSetsResponse } from './team-api.js';

/**
 * The permission matrix editor (F1.3). Rendered only for an Owner, because the
 * server refuses anyone else and offering the controls would be a lie.
 *
 * Permissions are listed by their stored id with a readable label beside it.
 * The catalogue comes from the server, so the editor can never offer a
 * permission the server would refuse.
 */
const LABELS: Record<string, string> = {
  [PERMISSIONS.CRM_VIEW]: 'View records',
  [PERMISSIONS.CRM_CREATE]: 'Create records',
  [PERMISSIONS.CRM_EDIT]: 'Edit records',
  [PERMISSIONS.CRM_DELETE]: 'Delete records',
  [PERMISSIONS.CRM_EXPORT]: 'Export records',
  [PERMISSIONS.OPPORTUNITY_VALUE_VIEW]: 'See opportunity values',
  [PERMISSIONS.ASSIGNMENT_RULES_MANAGE]: 'Manage assignment rules',
  [PERMISSIONS.INTEGRATIONS_MANAGE]: 'Manage integrations',
  [PERMISSIONS.AUDIT_LOG_VIEW]: 'View the audit log',
};

export interface PermissionMatrixProps {
  readonly member: Member;
  readonly sets: PermissionSetsResponse;
  readonly onDone: () => void;
}

export function PermissionMatrix({ member, sets, onDone }: PermissionMatrixProps) {
  const change = useChangePermissions();

  const [setIds, setSetIds] = useState<string[]>(member.permissionSetIds);
  const [extras, setExtras] = useState<string[]>(member.extraPermissions);

  // An Owner holds everything by level, so there is nothing to edit.
  const isOwner: boolean = (member.baseLevel satisfies BaseLevel) === 'owner';

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  /** What the member will end up with: the union of their sets and extras. */
  const effective = new Set<string>(extras);
  for (const id of setIds) {
    const set = sets.permissionSets.find((candidate) => candidate.id === id);
    for (const permission of set?.permissions ?? []) effective.add(permission);
  }

  if (isOwner) {
    return (
      <Notice>An Owner always holds every permission, so there is nothing to change here.</Notice>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        change.mutate(
          { membershipId: member.membershipId, permissionSetIds: setIds, extraPermissions: extras },
          { onSuccess: onDone },
        );
      }}
    >
      <Alert error={change.error} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Permission sets
        </legend>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          A set is a reusable group of permissions, like a role.
        </p>

        {sets.permissionSets.map((set) => (
          <label key={set.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={setIds.includes(set.id)}
              onChange={() => {
                setSetIds((current) => toggle(current, set.id));
              }}
              className="mt-1 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
            />
            <span className="min-w-0">
              <span className="font-medium text-slate-900 dark:text-slate-100">{set.name}</span>
              <span className="block text-xs text-slate-600 dark:text-slate-400">
                {set.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Extra permissions for this person
        </legend>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Granted on top of their sets. A permission already in a set stays granted either way.
        </p>

        {sets.assignablePermissions.map((permission) => {
          const fromSet = effective.has(permission) && !extras.includes(permission);

          return (
            <label key={permission} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={extras.includes(permission)}
                onChange={() => {
                  setExtras((current) => toggle(current, permission));
                }}
                className="focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
              />
              <span className="text-slate-800 dark:text-slate-200">
                {LABELS[permission] ?? permission}
              </span>
              {fromSet && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  already from a set
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={change.isPending} busyLabel="Saving…">
          Save permissions
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
