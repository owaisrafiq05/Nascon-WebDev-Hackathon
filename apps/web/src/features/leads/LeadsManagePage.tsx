import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Card, Empty, Loading, PageContainer, PageTitle, ROW_CLASS } from '../../components/ui.js';
import { useSession } from '../auth/session.js';
import { availabilityMessage } from './AvailabilityControl.js';
import { AssignmentRulesEditor } from './AssignmentRulesEditor.js';
import { RecoveryQueue } from './RecoveryQueue.js';
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUSES,
  useAvailability,
  useCreateLeadForm,
  useLeadForms,
  useSetAvailability,
  type AvailabilityMember,
  type AvailabilityStatus,
} from './leads-api.js';

/** Lead administration for managers: availability, recovery, rules, forms. */
export function LeadsManagePage() {
  return (
    <PageContainer>
      <PageTitle
        kicker="Workspace"
        sub="Who can take leads, what needs rescuing, and how leads are routed."
      >
        Leads admin
      </PageTitle>

      <Card id="board" title="Availability board">
        <AvailabilityBoard />
      </Card>
      <Card id="recovery" title="Recovery queue">
        <RecoveryQueue />
      </Card>
      <Card id="rules" title="Assignment rules">
        <AssignmentRulesEditor />
      </Card>
      <LeadFormsCard />
    </PageContainer>
  );
}

function AvailabilityBoard() {
  const availability = useAvailability();

  if (availability.isPending) return <Loading>Loading team availability…</Loading>;
  if (availability.error !== null) return <Alert error={availability.error} />;
  if (availability.data.members.length === 0) return <Empty>No members yet.</Empty>;

  return (
    <ul className="flex flex-col gap-2">
      {availability.data.members.map((member) => (
        <MemberAvailabilityRow key={member.membershipId} member={member} />
      ))}
    </ul>
  );
}

function MemberAvailabilityRow({ member }: { member: AvailabilityMember }) {
  const set = useSetAvailability();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? member.availabilityStatus;

  return (
    <li className={ROW_CLASS}>
      <div className="min-w-0">
        <p className="font-medium break-all text-slate-900 dark:text-slate-100">{member.email}</p>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Now: {AVAILABILITY_LABELS[member.availabilityStatus] ?? member.availabilityStatus} · Open
          leads: {member.openLeadCount ?? 0}
        </p>
      </div>
      <form
        noValidate
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          set.mutate({ membershipId: member.membershipId, status: value as AvailabilityStatus });
        }}
      >
        <Select
          label={`Availability for ${member.email}`}
          value={value}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        >
          {AVAILABILITY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {AVAILABILITY_LABELS[status]}
            </option>
          ))}
        </Select>
        <Button type="submit" busy={set.isPending} busyLabel="Updating…">
          Update
        </Button>
        <div aria-live="polite" className="w-full">
          <Alert error={set.error} />
          {set.isSuccess && (
            <Notice>
              Updated.{' '}
              {availabilityMessage(
                set.data.reassignedLeadIds.length,
                set.data.flaggedLeadIds.length,
              )}
            </Notice>
          )}
        </div>
      </form>
    </li>
  );
}

function LeadFormsCard() {
  const session = useSession();
  const forms = useLeadForms();
  const create = useCreateLeadForm();
  const [name, setName] = useState('');
  const canCreate =
    session.data?.membership.permissions.includes(PERMISSIONS.ASSIGNMENT_RULES_MANAGE) ?? false;

  return (
    <Card id="forms" title="Lead forms">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Each form has an endpoint. Post a website form to it to create a lead (F3.1).
      </p>
      {forms.isPending && <Loading>Loading forms…</Loading>}
      <Alert error={forms.error} />
      {forms.data !== undefined && forms.data.forms.length === 0 && (
        <Empty>No lead forms yet.</Empty>
      )}
      {forms.data !== undefined && forms.data.forms.length > 0 && (
        <ul className="flex flex-col gap-2">
          {forms.data.forms.map((form) => (
            <li key={form.id} className={ROW_CLASS}>
              <div className="min-w-0">
                <p className="font-medium break-words">{form.name}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Source: {form.sourceLabel ?? form.name} ·{' '}
                  {form.enabled === false ? 'Disabled' : 'Enabled'}
                </p>
                <p className="text-sm break-all">
                  Endpoint: <code>{`${window.location.origin}${form.endpoint}`}</code>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canCreate && (
        <form
          noValidate
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === '') return;
            create.mutate(
              { name: name.trim() },
              {
                onSuccess: () => {
                  setName('');
                },
              },
            );
          }}
        >
          <Field
            label="New form name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div aria-live="polite">
            <Alert error={create.error} />
            {create.isSuccess && (
              <Notice>
                Form created. Its endpoint is {`${window.location.origin}${create.data.endpoint}`}
              </Notice>
            )}
          </div>
          <div>
            <Button type="submit" busy={create.isPending} busyLabel="Creating…">
              Create form
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
