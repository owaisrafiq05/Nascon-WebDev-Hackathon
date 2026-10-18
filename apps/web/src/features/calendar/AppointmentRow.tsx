import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Badge, ROW_CLASS } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { ConflictList } from './BookAppointmentForm.js';
import {
  conflictsOf,
  useCancelAppointment,
  useRescheduleAppointment,
  type Appointment,
  type RescheduleInput,
} from './calendar-api.js';
import { browserTimeZone, toZonedFields, zonedTimeToUtc } from './zoned-time.js';

const STATUS_LABELS: Record<string, string> = { scheduled: 'Scheduled', cancelled: 'Cancelled' };

/** One appointment with reschedule and cancel (I3.3). */
export function AppointmentRow({ appointment }: { appointment: Appointment }) {
  const zone = appointment.timeZone ?? browserTimeZone();
  const cancel = useCancelAppointment();
  const reschedule = useRescheduleAppointment();
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const initial = toZonedFields(appointment.startsAt, zone);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState<RescheduleInput | null>(null);

  const cancelled = appointment.status === 'cancelled';
  const durationMs = Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt);
  const conflicts =
    reschedule.error instanceof ApiError && reschedule.error.status === 409
      ? conflictsOf(reschedule.error)
      : [];

  function send(input: RescheduleInput): void {
    setPending(input);
    reschedule.mutate(input, {
      onSuccess: () => {
        setEditing(false);
        setPending(null);
      },
    });
  }

  return (
    <li className={ROW_CLASS}>
      <div className="min-w-0">
        <p className="font-medium break-words text-slate-900 dark:text-slate-100">
          {appointment.title}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {formatDateTime(appointment.startsAt, zone)} to {formatDateTime(appointment.endsAt, zone)}{' '}
          ({zone})
        </p>
        <p className="text-sm break-all text-slate-600 dark:text-slate-400">
          With {appointment.employeeEmail ?? 'unassigned'}
          {appointment.contactName != null && ` · ${appointment.contactName}`}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <Badge tone={cancelled ? 'warn' : 'good'} symbol={cancelled ? '✕' : '✓'}>
            {STATUS_LABELS[appointment.status] ?? appointment.status}
          </Badge>
          {appointment.googleEventLink != null && (
            <a
              href={appointment.googleEventLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              Open in Google Calendar
            </a>
          )}
        </p>
      </div>

      {!cancelled && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            aria-expanded={editing}
            onClick={() => {
              setEditing((open) => !open);
            }}
          >
            Reschedule
          </Button>
          {!confirmCancel ? (
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              Cancel appointment
            </Button>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm">Cancel this appointment?</span>
              <Button
                type="button"
                variant="danger"
                busy={cancel.isPending}
                busyLabel="Cancelling…"
                onClick={() => {
                  cancel.mutate(appointment.id);
                }}
              >
                Yes, cancel it
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setConfirmCancel(false);
                }}
              >
                Keep it
              </Button>
            </span>
          )}
        </div>
      )}

      <div aria-live="polite" className="w-full">
        <Alert error={cancel.error} />
        {cancel.isSuccess && <Notice>Appointment cancelled.</Notice>}
        {reschedule.isSuccess && !editing && <Notice>Appointment rescheduled.</Notice>}
      </div>

      {editing && !cancelled && (
        <form
          noValidate
          className="flex w-full flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const start = zonedTimeToUtc(date, time, zone);
              setLocalError(null);
              send({
                id: appointment.id,
                startsAt: start.toISOString(),
                endsAt: new Date(start.getTime() + durationMs).toISOString(),
                timeZone: zone,
                version: appointment.version,
              });
            } catch {
              setLocalError('Choose a valid date and time.');
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={`New date for ${appointment.title}`}
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
            />
            <Field
              label={`New start time for ${appointment.title}`}
              type="time"
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
              }}
              hint={`Time zone: ${zone}`}
            />
          </div>
          <div aria-live="polite" className="flex flex-col gap-2">
            {localError !== null && <Alert error={new Error(localError)} />}
            {reschedule.error !== null && conflicts.length === 0 && (
              <Alert error={reschedule.error} />
            )}
            {conflicts.length > 0 && pending !== null && (
              <div
                role="alert"
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950"
              >
                <p className="text-sm font-medium">That time overlaps another appointment:</p>
                <ConflictList conflicts={conflicts} timeZone={zone} />
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    busy={reschedule.isPending}
                    busyLabel="Rescheduling…"
                    onClick={() => {
                      send({ ...pending, allowOverlap: true });
                    }}
                  >
                    Reschedule anyway
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div>
            <Button
              type="submit"
              busy={reschedule.isPending && conflicts.length === 0}
              busyLabel="Saving…"
            >
              Save new time
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
