import { useState } from 'react';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Pager } from '../../components/Pager.js';
import { Select } from '../../components/Select.js';
import { Card, Empty, Loading, PageContainer, PageTitle } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';
import { IntegrationCard } from './IntegrationCard.js';
import {
  useFailedNotifications,
  useIntegrationEvents,
  useIntegrations,
} from './integrations-api.js';

const PROVIDERS = ['', 'twilio', 'stripe', 'telegram', 'google'] as const;

export function IntegrationsPage() {
  const integrations = useIntegrations();

  return (
    <PageContainer wide>
      <PageTitle sub="Connect the services the platform sends messages, payments and alerts through.">
        Integrations
      </PageTitle>

      {integrations.isPending && <Loading>Loading integrations…</Loading>}
      {integrations.error !== null && (
        <div className="flex flex-col gap-3">
          <Alert error={integrations.error} />
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void integrations.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {integrations.data?.integrations.map((integration) => (
          <IntegrationCard key={integration.provider} integration={integration} />
        ))}
      </div>

      <SyncHistory />
      <FailedAlerts />
    </PageContainer>
  );
}

const TABLE = 'w-full min-w-[32rem] text-left text-sm';
const TH = 'px-2 py-1.5 font-semibold';
const TD = 'px-2 py-1.5 align-top break-words';

function SyncHistory() {
  const [provider, setProvider] = useState('');
  const [page, setPage] = useState(1);
  const events = useIntegrationEvents({ provider, page });

  return (
    <Card id="history" title="Sync history">
      <div className="mb-3">
        <Select
          label="Provider"
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value);
            setPage(1);
          }}
        >
          {PROVIDERS.map((value) => (
            <option key={value} value={value}>
              {value === '' ? 'All providers' : value}
            </option>
          ))}
        </Select>
      </div>
      {events.isPending && <Loading>Loading history…</Loading>}
      <Alert error={events.error} />
      {events.data?.items.length === 0 && <Empty>No events yet.</Empty>}
      {events.data !== undefined && events.data.items.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <caption className="sr-only">Integration events</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    When
                  </th>
                  <th scope="col" className={TH}>
                    Provider
                  </th>
                  <th scope="col" className={TH}>
                    Direction
                  </th>
                  <th scope="col" className={TH}>
                    Kind
                  </th>
                  <th scope="col" className={TH}>
                    Result
                  </th>
                  <th scope="col" className={TH}>
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.data.items.map((event) => (
                  <tr key={event.id} className="border-t border-slate-200 dark:border-slate-700">
                    <td className={TD}>{formatDateTime(event.createdAt)}</td>
                    <td className={TD}>{event.provider}</td>
                    <td className={TD}>{event.direction ?? '—'}</td>
                    <td className={TD}>{event.kind ?? '—'}</td>
                    <td className={TD}>
                      {event.result === 'ok' ? '✓ ' : '! '}
                      {event.result}
                      {event.httpStatus != null && ` (${String(event.httpStatus)})`}
                    </td>
                    <td className={TD}>{event.error ?? event.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager pageInfo={events.data.pageInfo} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function FailedAlerts() {
  const [page, setPage] = useState(1);
  const alerts = useFailedNotifications(page);

  return (
    <Card id="failed-alerts" title="Failed alerts">
      {alerts.isPending && <Loading>Loading alerts…</Loading>}
      <Alert error={alerts.error} />
      {alerts.data?.items.length === 0 && <Empty>No failed alerts.</Empty>}
      {alerts.data !== undefined && alerts.data.items.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <caption className="sr-only">Failed alerts</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    When
                  </th>
                  <th scope="col" className={TH}>
                    Member
                  </th>
                  <th scope="col" className={TH}>
                    Attempts
                  </th>
                  <th scope="col" className={TH}>
                    Error
                  </th>
                </tr>
              </thead>
              <tbody>
                {alerts.data.items.map((alert) => (
                  <tr key={alert.id} className="border-t border-slate-200 dark:border-slate-700">
                    <td className={TD}>{formatDateTime(alert.createdAt)}</td>
                    <td className={TD}>{alert.memberEmail ?? '—'}</td>
                    <td className={TD}>{alert.attempts ?? 0}</td>
                    <td className={TD}>! {alert.lastError ?? 'Failed'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager pageInfo={alerts.data.pageInfo} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
