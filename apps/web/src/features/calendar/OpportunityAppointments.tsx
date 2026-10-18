import { Alert } from '../../components/Alert.js';
import { Card, Empty, Loading } from '../../components/ui.js';
import { AppointmentRow } from './AppointmentRow.js';
import { BookAppointmentForm } from './BookAppointmentForm.js';
import { useAppointments } from './calendar-api.js';

/** Appointments tied to one opportunity, plus the booking form (I3). */
export function OpportunityAppointments({
  opportunityId,
  contactId,
}: {
  opportunityId: string;
  contactId: string | null;
}) {
  const appointments = useAppointments({ opportunityId });
  return (
    <>
      <Card id="opp-appointments" title="Appointments">
        {appointments.isPending && <Loading>Loading appointments…</Loading>}
        <Alert error={appointments.error} />
        {appointments.data?.items.length === 0 && <Empty>No appointments yet.</Empty>}
        {appointments.data !== undefined && appointments.data.items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {appointments.data.items.map((appointment) => (
              <AppointmentRow key={appointment.id} appointment={appointment} />
            ))}
          </ul>
        )}
      </Card>
      {contactId !== null ? (
        <BookAppointmentForm contactId={contactId} opportunityId={opportunityId} />
      ) : (
        <Card id="book-unavailable" title="Book an appointment">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Link this opportunity to a contact to book an appointment.
          </p>
        </Card>
      )}
    </>
  );
}
