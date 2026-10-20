import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Pager } from '../../components/Pager.js';
import { Empty, Loading, PageContainer, PageTitle } from '../../components/ui.js';
import { AppointmentRow } from './AppointmentRow.js';
import { useAppointments } from './calendar-api.js';

/** Appointments across the workspace; `?upcoming=false` shows the past too. */
export function AppointmentsPage() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const upcoming = params.get('upcoming') !== 'false';
  const employeeMembershipId = params.get('employeeMembershipId') ?? '';
  const appointments = useAppointments({
    upcoming,
    page,
    ...(employeeMembershipId === '' ? {} : { employeeMembershipId }),
  });

  return (
    <PageContainer>
      <PageTitle
        kicker="Work"
        sub="Appointments booked with your contacts. Times are shown in each appointment's own time zone."
      >
        Appointments
      </PageTitle>

      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={upcoming}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            if (event.target.checked) next.delete('upcoming');
            else next.set('upcoming', 'false');
            setParams(next, { replace: true });
            setPage(1);
          }}
        />
        Upcoming only
      </label>

      {employeeMembershipId !== '' && (
        <p className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          Showing one employee's appointments.
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('employeeMembershipId');
              setParams(next, { replace: true });
              setPage(1);
            }}
          >
            Show everyone
          </Button>
        </p>
      )}

      {appointments.isPending && <Loading>Loading appointments…</Loading>}
      {appointments.error !== null && (
        <div className="flex flex-col gap-3">
          <Alert error={appointments.error} />
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void appointments.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      )}
      {appointments.data?.items.length === 0 && <Empty>No appointments.</Empty>}
      {appointments.data !== undefined && appointments.data.items.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {appointments.data.items.map((appointment) => (
              <AppointmentRow key={appointment.id} appointment={appointment} />
            ))}
          </ul>
          <Pager pageInfo={appointments.data.pageInfo} onPage={setPage} />
        </>
      )}
    </PageContainer>
  );
}
