import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Select } from '../../components/Select.js';
import { Empty, Loading, ROW_CLASS } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';
import { useSession } from '../auth/session.js';
import {
  useAvailability,
  useReassignLead,
  useRecoveryQueue,
  type AvailabilityMember,
  type RecoveryItem,
} from './leads-api.js';

/** Leads that need a person to step in (F3.7), with a reassign control each. */
export function RecoveryQueue() {
  const queue = useRecoveryQueue();
  const availability = useAvailability();
  const session = useSession();
  const canReassign =
    session.data?.membership.permissions.includes(PERMISSIONS.MEMBERS_MANAGE) ?? false;

  if (queue.isPending) return <Loading>Loading the recovery queue…</Loading>;
  if (queue.error !== null) {
    return (
      <div className="flex flex-col gap-3">
        <Alert error={queue.error} />
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void queue.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (queue.data.items.length === 0) return <Empty>Nothing needs recovery right now.</Empty>;

  return (
    <ul className="flex flex-col gap-2">
      {queue.data.items.map((item) => (
        <RecoveryRow
          key={item.leadId}
          item={item}
          members={availability.data?.members ?? []}
          canReassign={canReassign}
        />
      ))}
    </ul>
  );
}

function RecoveryRow({
  item,
  members,
  canReassign,
}: {
  item: RecoveryItem;
  members: AvailabilityMember[];
  canReassign: boolean;
}) {
  const reassign = useReassignLead();
  const [target, setTarget] = useState('');

  return (
    <li className={ROW_CLASS}>
      <div className="min-w-0">
        <p className="font-medium break-words text-slate-900 dark:text-slate-100">
          {item.sourceLabel ?? 'Lead'}
        </p>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Why: {item.reasonLabels.length > 0 ? item.reasonLabels.join(', ') : 'Needs attention'}
        </p>
        <p className="text-sm break-all text-slate-600 dark:text-slate-400">
          Assigned to: {item.assigneeEmail ?? 'Nobody'} · Escalations: {item.escalationCount ?? 0} ·
          Last activity: {formatDateTime(item.lastActivityAt ?? item.createdAt)}
        </p>
      </div>

      {canReassign && (
        <form
          noValidate
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            reassign.mutate({
              leadId: item.leadId,
              ...(target === '' ? {} : { toMembershipId: target }),
            });
          }}
        >
          <Select
            label={`Reassign lead from ${item.sourceLabel ?? 'unknown source'} to`}
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
            }}
          >
            <option value="">Next eligible</option>
            {members.map((member) => (
              <option key={member.membershipId} value={member.membershipId}>
                {member.email}
              </option>
            ))}
          </Select>
          <Button type="submit" busy={reassign.isPending} busyLabel="Reassigning…">
            Reassign
          </Button>
          <div aria-live="polite" className="w-full">
            <Alert error={reassign.error} />
            {reassign.isSuccess && (
              <Notice>
                {reassign.data.reassigned ? 'Reassigned.' : 'No eligible employee was available.'}
              </Notice>
            )}
          </div>
        </form>
      )}
    </li>
  );
}
