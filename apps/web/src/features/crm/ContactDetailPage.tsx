import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { BACK_LINK, KICKER_CLASS } from '../../components/ui.js';
import { useSession } from '../auth/session.js';
import { AppointmentRow } from '../calendar/AppointmentRow.js';
import { BookAppointmentForm } from '../calendar/BookAppointmentForm.js';
import { ContactMessaging } from '../messaging/ContactMessaging.js';
import { PaymentRow } from '../payments/PaymentRow.js';
import { useAddNote, useCustomerView, type CustomerView } from './crm-api.js';

/**
 * The complete customer view (F2.8).
 *
 * One request supplies every section. The three that P7, P8 and P9 will fill in
 * say what they are waiting on rather than rendering as empty boxes, which is
 * the difference between "nothing has happened" and "this is not connected"
 * (Q10).
 */
export function ContactDetailPage() {
  const { contactId = '' } = useParams();
  const session = useSession();
  const view = useCustomerView(contactId);

  const permissions = session.data?.membership.permissions ?? [];
  const canEdit = permissions.includes(PERMISSIONS.CRM_EDIT);

  if (view.isPending) {
    return (
      <p role="status" className="p-6 text-sm text-slate-600 dark:text-slate-400">
        Loading the contact…
      </p>
    );
  }

  if (view.error !== null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <Alert error={view.error} />
        <p className="mt-4">
          <Link to="/contacts" className="text-sm underline">
            Back to contacts
          </Link>
        </p>
      </div>
    );
  }

  const data = view.data;
  if (data === undefined) return null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <p className="text-sm">
        <Link
          to="/contacts"
          className={BACK_LINK}
        >
          ← Contacts
        </Link>
      </p>

      <header className="mt-3">
        <p className={KICKER_CLASS}>Records</p>
        <h1 className="mt-1 text-2xl font-semibold break-words text-slate-900 sm:text-3xl dark:text-slate-50">
          {data.contact.displayName}
        </h1>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
          {data.company !== null && (
            <div className="flex gap-1">
              <dt>Company:</dt>
              <dd className="text-slate-900 dark:text-slate-100">{data.company.name}</dd>
            </div>
          )}
          <div className="flex gap-1">
            <dt>Email:</dt>
            <dd className="break-all text-slate-900 dark:text-slate-100">
              {data.contact.email ?? '—'}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Phone:</dt>
            <dd className="text-slate-900 dark:text-slate-100">{data.contact.phone ?? '—'}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Assigned to:</dt>
            <dd className="break-all text-slate-900 dark:text-slate-100">
              {data.assignedEmployee?.email ?? 'Nobody'}
            </dd>
          </div>
        </dl>

        {data.contact.tags.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {data.contact.tags.map((tag) => (
              <li
                key={tag}
                className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}

        {data.contact.optedOutOfMessaging && (
          <p className="mt-3 text-sm font-medium text-amber-700 dark:text-amber-400">
            ◐ This contact has opted out of messaging.
          </p>
        )}
      </header>

      <Opportunities view={data} />

      <Conversations view={data} contactId={contactId} canEdit={canEdit} />
      <Payments view={data} />
      <Appointments view={data} contactId={contactId} canEdit={canEdit} />

      <Timeline view={data} contactId={contactId} canEdit={canEdit} />
    </div>
  );
}

function Opportunities({ view }: { view: CustomerView }) {
  return (
    <section aria-labelledby="opportunities-heading" className="mt-8">
      <h2
        id="opportunities-heading"
        className="text-base font-semibold text-slate-900 dark:text-slate-50"
      >
        Opportunities
      </h2>

      {view.opportunities.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          No opportunities for this contact yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {view.opportunities.map((opportunity) => (
            <li
              key={opportunity.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
            >
              <Link
                to={`/opportunities/${opportunity.id}`}
                className="min-w-0 font-medium break-words text-slate-900 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:text-slate-100"
              >
                {opportunity.name}
              </Link>
              <span className="text-sm text-slate-600 dark:text-slate-400">
                {opportunity.pipelineName ?? '—'} · {opportunity.stageName ?? opportunity.stageId}
                {' · '}
                {opportunity.valueMasked === true
                  ? 'Value hidden'
                  : opportunity.value === null || opportunity.value === undefined
                    ? 'No value'
                    : `${opportunity.currency ?? ''} ${(opportunity.value / 100).toFixed(2)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A section heading with the shared look. */
function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-base font-semibold text-slate-900 dark:text-slate-50">
      {children}
    </h2>
  );
}

/** Says why a section is empty: nothing happened yet, or it is not connected (Q10). */
function EmptySection({
  reason,
  fallback,
}: {
  reason: string | null | undefined;
  fallback: string;
}) {
  return (
    <p className="mt-2 rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600 dark:border-slate-600 dark:text-slate-400">
      {reason ?? fallback}
    </p>
  );
}

function Conversations({
  view,
  contactId,
  canEdit,
}: {
  view: CustomerView;
  contactId: string;
  canEdit: boolean;
}) {
  const section = view.conversations;
  return (
    <section aria-labelledby="conversations-heading" className="mt-8">
      <SectionHeading id="conversations-heading">Conversations</SectionHeading>
      {section.items.length === 0 ? (
        <EmptySection reason={section.reason} fallback="No conversations yet." />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {section.items.map((conversation) => (
            <li
              key={conversation.id}
              className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
            >
              <Link
                to={`/conversations/${conversation.id}`}
                className="font-medium text-slate-900 underline underline-offset-2 dark:text-slate-100"
              >
                {(conversation.channel ?? 'message').toUpperCase()} ·{' '}
                {conversation.address ?? 'conversation'}
              </Link>
              <p className="text-sm break-words text-slate-600 dark:text-slate-400">
                {conversation.lastMessagePreview ?? 'No messages'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <ContactMessaging contactId={contactId} optedOut={view.contact.optedOutOfMessaging} />
      )}
    </section>
  );
}

function Payments({ view }: { view: CustomerView }) {
  const section = view.payments;
  return (
    <section aria-labelledby="payments-heading" className="mt-8">
      <SectionHeading id="payments-heading">Payments</SectionHeading>
      {section.items.length === 0 ? (
        <EmptySection reason={section.reason} fallback="No payments yet." />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {section.items.map((payment) => (
            <PaymentRow key={payment.id} payment={payment} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Appointments({
  view,
  contactId,
  canEdit,
}: {
  view: CustomerView;
  contactId: string;
  canEdit: boolean;
}) {
  const section = view.appointments;
  return (
    <section aria-labelledby="appointments-heading" className="mt-8">
      <SectionHeading id="appointments-heading">Appointments</SectionHeading>
      {section.items.length === 0 ? (
        <EmptySection reason={section.reason} fallback="No appointments yet." />
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {section.items.map((appointment) => (
            <AppointmentRow key={appointment.id} appointment={appointment} />
          ))}
        </ul>
      )}
      {canEdit && <BookAppointmentForm contactId={contactId} />}
    </section>
  );
}

function Timeline({
  view,
  contactId,
  canEdit,
}: {
  view: CustomerView;
  contactId: string;
  canEdit: boolean;
}) {
  const addNote = useAddNote();
  const [note, setNote] = useState('');

  return (
    <section aria-labelledby="activity-heading" className="mt-8">
      <h2
        id="activity-heading"
        className="text-base font-semibold text-slate-900 dark:text-slate-50"
      >
        Activity
      </h2>

      {canEdit && (
        <form
          noValidate
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim() === '') return;

            addNote.mutate(
              { contactId, body: note.trim() },
              {
                onSuccess: () => {
                  setNote('');
                },
              },
            );
          }}
        >
          <Field
            label="Add a note"
            name="note"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <div aria-live="polite">
            <Alert error={addNote.error} />
            {addNote.isSuccess && note === '' && <Notice>Note added.</Notice>}
          </div>
          <div>
            <Button type="submit" busy={addNote.isPending} busyLabel="Saving…">
              Add note
            </Button>
          </div>
        </form>
      )}

      {view.activity.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">Nothing recorded yet.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-3">
          {view.activity.map((entry) => (
            <li
              key={entry.id}
              className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
            >
              <p className="text-sm break-words text-slate-900 dark:text-slate-100">
                {entry.summary}
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                {entry.actor.label} · {new Date(entry.createdAt).toLocaleString()} ·{' '}
                <span className="font-mono">{entry.type}</span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
