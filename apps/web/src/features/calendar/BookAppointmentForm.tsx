import { useMemo, useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { TextArea } from '../../components/TextArea.js';
import { Card } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import {
  conflictsOf,
  useBookAppointment,
  useBusyIntervals,
  useCalendarEmployees,
  type BookInput,
  type Interval,
} from './calendar-api.js';
import { browserTimeZone, dayRangeUtc, zonedTimeToUtc } from './zoned-time.js';

export function ConflictList({ conflicts, timeZone }: { conflicts: Interval[]; timeZone: string }) {
  return (
    <ul className="mt-1 list-disc pl-5 text-sm">
      {conflicts.map((interval) => (
        <li key={`${interval.start}-${interval.end}`}>
          {formatDateTime(interval.start, timeZone)} to {formatDateTime(interval.end, timeZone)}
        </li>
      ))}
    </ul>
  );
}

/** Book an appointment with an employee (I3.1, I3.2). */
export function BookAppointmentForm({
  contactId,
  opportunityId,
}: {
  contactId: string;
  opportunityId?: string;
}) {
  const employees = useCalendarEmployees();
  const book = useBookAppointment();

  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState('30');
  const [timeZone, setTimeZone] = useState(browserTimeZone());
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState<BookInput | null>(null);

  // The day's busy intervals in the chosen zone, so a clash is visible before submitting.
  const dayQuery = useMemo(() => {
    if (employeeId === '' || date === '') return null;
    try {
      const { from, to } = dayRangeUtc(date, timeZone);
      return { membershipId: employeeId, from: from.toISOString(), to: to.toISOString() };
    } catch {
      return null;
    }
  }, [employeeId, date, timeZone]);
  const busy = useBusyIntervals(dayQuery);

  const conflicts =
    book.error instanceof ApiError && book.error.status === 409 ? conflictsOf(book.error) : [];
  const fieldErrors = book.error instanceof ApiError ? (book.error.fields ?? {}) : {};

  function build(): BookInput | null {
    const minutes = Number(duration);
    if (employeeId === '') return fail('Choose who the appointment is with.');
    if (title.trim() === '') return fail('Enter a title.');
    if (date === '' || time === '') return fail('Choose a date and a start time.');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      return fail('Duration must be between 5 and 1440 minutes.');
    }
    try {
      const start = zonedTimeToUtc(date, time, timeZone.trim());
      const end = new Date(start.getTime() + minutes * 60_000);
      setLocalError(null);
      return {
        contactId,
        ...(opportunityId === undefined ? {} : { opportunityId }),
        employeeMembershipId: employeeId,
        title: title.trim(),
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timeZone: timeZone.trim(),
      };
    } catch {
      return fail('That time zone is not recognised. Use a name like Europe/London.');
    }
  }

  function fail(message: string): null {
    setLocalError(message);
    return null;
  }

  function submit(input: BookInput): void {
    setPending(input);
    book.mutate(input, {
      onSuccess: () => {
        setTitle('');
        setNotes('');
        setPending(null);
      },
    });
  }

  return (
    <Card id="book" title="Book an appointment">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const input = build();
          if (input !== null) submit(input);
        }}
      >
        <Select
          label="With"
          value={employeeId}
          onChange={(event) => {
            setEmployeeId(event.target.value);
          }}
          hint={employees.isPending ? 'Loading employees…' : undefined}
        >
          <option value="">Choose an employee</option>
          {(employees.data?.items ?? []).map((employee) => (
            <option
              key={employee.membershipId}
              value={employee.membershipId}
              disabled={!employee.bookable}
            >
              {employee.name ?? employee.email}
              {employee.bookable
                ? ''
                : ` (unavailable: ${employee.reason ?? 'calendar not connected'})`}
            </option>
          ))}
        </Select>
        <Alert error={employees.error} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Date"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
          <Field
            label="Start time"
            type="time"
            value={time}
            onChange={(event) => {
              setTime(event.target.value);
            }}
          />
          <Field
            label="Duration (minutes)"
            type="number"
            min={5}
            value={duration}
            onChange={(event) => {
              setDuration(event.target.value);
            }}
          />
          <Field
            label="Time zone"
            list="timezone-options"
            value={timeZone}
            onChange={(event) => {
              setTimeZone(event.target.value);
            }}
            error={fieldErrors['timeZone']}
          />
        </div>
        <datalist id="timezone-options">
          {supportedZones().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>

        {dayQuery !== null && (
          <div aria-live="polite" className="text-sm text-slate-700 dark:text-slate-300">
            {busy.isPending && <p>Checking their calendar…</p>}
            <Alert error={busy.error} />
            {busy.data !== undefined && busy.data.busy.length === 0 && (
              <p>They have nothing booked on this day ({timeZone}).</p>
            )}
            {busy.data !== undefined && busy.data.busy.length > 0 && (
              <div>
                <p className="font-medium">Already busy on this day ({timeZone}):</p>
                <ConflictList conflicts={busy.data.busy} timeZone={timeZone} />
              </div>
            )}
          </div>
        )}

        <Field
          label="Title"
          required
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          error={fieldErrors['title']}
        />
        <TextArea
          label="Notes"
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
        />

        <div aria-live="polite" className="flex flex-col gap-2">
          {localError !== null && <Alert error={new Error(localError)} />}
          {book.error !== null && conflicts.length === 0 && <Alert error={book.error} />}
          {conflicts.length > 0 && pending !== null && (
            <div
              role="alert"
              className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950"
            >
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                That time overlaps another appointment:
              </p>
              <ConflictList conflicts={conflicts} timeZone={pending.timeZone} />
              <div className="mt-2">
                <Button
                  type="button"
                  variant="secondary"
                  busy={book.isPending}
                  busyLabel="Booking…"
                  onClick={() => {
                    submit({ ...pending, allowOverlap: true });
                  }}
                >
                  Book anyway
                </Button>
              </div>
            </div>
          )}
          {book.isSuccess && (
            <Notice>
              Appointment booked for{' '}
              {formatDateTime(book.data.startsAt, book.data.timeZone ?? timeZone)} (
              {book.data.timeZone ?? timeZone}).
              {book.data.googleEventLink != null && (
                <>
                  {' '}
                  <a
                    href={book.data.googleEventLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Open in Google Calendar
                  </a>
                </>
              )}
            </Notice>
          )}
        </div>

        <div>
          <Button
            type="submit"
            busy={book.isPending && conflicts.length === 0}
            busyLabel="Booking…"
          >
            Book appointment
          </Button>
        </div>
      </form>
    </Card>
  );
}

function supportedZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}
