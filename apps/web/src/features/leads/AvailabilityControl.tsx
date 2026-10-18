import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Select } from '../../components/Select.js';
import { useSession } from '../auth/session.js';
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUSES,
  useAvailability,
  useSetAvailability,
  type AvailabilityStatus,
} from './leads-api.js';

export function availabilityMessage(reassigned: number, flagged: number): string {
  const lead = (n: number): string => (n === 1 ? 'lead' : 'leads');
  const parts = [
    `${String(reassigned)} unacknowledged ${lead(reassigned)} ${reassigned === 1 ? 'was' : 'were'} reassigned`,
    `${String(flagged)} acknowledged ${lead(flagged)} ${flagged === 1 ? 'stays' : 'stay'} with you, flagged owner unavailable`,
  ];
  return `${parts.join('; ')}.`;
}

/** The member's own availability (F3.2, F3.6). */
export function AvailabilityControl() {
  const session = useSession();
  const availability = useAvailability();
  const setAvailability = useSetAvailability();
  const [draft, setDraft] = useState<AvailabilityStatus | null>(null);

  const myId = session.data?.membership.id ?? '';
  const mine = availability.data?.members.find((member) => member.membershipId === myId);
  const current = (draft ?? mine?.availabilityStatus ?? 'available') as AvailabilityStatus;

  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setAvailability.mutate({ membershipId: myId, status: current });
      }}
    >
      <Select
        label="My availability"
        value={current}
        onChange={(event) => {
          setDraft(event.target.value as AvailabilityStatus);
        }}
      >
        {AVAILABILITY_STATUSES.map((status) => (
          <option key={status} value={status}>
            {AVAILABILITY_LABELS[status]}
          </option>
        ))}
      </Select>
      <Button
        type="submit"
        busy={setAvailability.isPending}
        busyLabel="Updating…"
        disabled={myId === ''}
      >
        Update availability
      </Button>
      <div aria-live="polite" className="w-full">
        <Alert error={setAvailability.error} />
        {setAvailability.isSuccess && (
          <Notice>
            Availability updated.{' '}
            {availabilityMessage(
              setAvailability.data.reassignedLeadIds.length,
              setAvailability.data.flaggedLeadIds.length,
            )}
          </Notice>
        )}
      </div>
    </form>
  );
}
