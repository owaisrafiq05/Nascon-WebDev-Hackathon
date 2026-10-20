import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Pager } from '../../components/Pager.js';
import { Select } from '../../components/Select.js';
import { Card, Empty, Loading, PageContainer, PageTitle } from '../../components/ui.js';
import { useNow } from '../../lib/use-now.js';
import { useSession } from '../auth/session.js';
import { AvailabilityControl } from './AvailabilityControl.js';
import { LeadRow } from './LeadRow.js';
import { NewLeadForm } from './NewLeadForm.js';
import { useAcknowledgeLead, useLeads } from './leads-api.js';

/**
 * The lead inbox (F3.4): what is mine, how long I have, and a way to take it.
 *
 * `status`, `createdFrom`, `createdTo` and `mine` come from the URL so a
 * dashboard tile can drill straight into the leads it counted (F5).
 */
export function LeadsPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const nowMs = useNow();

  const permissions = session.data?.membership.permissions ?? [];
  const canSeeAll = permissions.includes(PERMISSIONS.MEMBERS_MANAGE);
  const canCreate = permissions.includes(PERMISSIONS.CRM_CREATE);
  const myId = session.data?.membership.id ?? '';

  const showAll = canSeeAll && params.get('mine') === 'false';
  const status = params.get('status') ?? '';
  const createdFrom = params.get('createdFrom') ?? '';
  const createdTo = params.get('createdTo') ?? '';

  const leads = useLeads({
    mine: showAll ? 'false' : 'true',
    status,
    createdFrom,
    createdTo,
    page: String(page),
  });
  const acknowledge = useAcknowledgeLead();

  const filtered = status !== '' || createdFrom !== '' || createdTo !== '';

  function update(key: string, value: string | null): void {
    const next = new URLSearchParams(params);
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
    setPage(1);
  }

  return (
    <PageContainer>
      <PageTitle
        kicker="Work"
        sub="Leads assigned to you. Acknowledge each one before its timer runs out."
      >
        Leads
      </PageTitle>

      <Card id="availability" title="My availability">
        <AvailabilityControl />
      </Card>

      {canCreate && (
        <Card id="new-lead" title="New lead">
          <NewLeadForm />
        </Card>
      )}

      <Card
        id="inbox"
        title={showAll ? 'All open leads' : 'My leads'}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {canSeeAll && (
              <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(event) => {
                    update('mine', event.target.checked ? 'false' : null);
                  }}
                />
                All leads
              </label>
            )}
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Select
            label="Status"
            value={status}
            onChange={(event) => {
              update('status', event.target.value);
            }}
          >
            <option value="">Open (default)</option>
            <option value="converted">Converted</option>
            <option value="closed">Closed</option>
            <option value="all">All statuses</option>
          </Select>
          {filtered && (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                {createdFrom !== '' && `From ${new Date(createdFrom).toLocaleString()} `}
                {createdTo !== '' && `to ${new Date(createdTo).toLocaleString()}`}
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setParams(new URLSearchParams(), { replace: true });
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            </>
          )}
          {canSeeAll && (
            <Link
              to="/leads/manage"
              className="text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
            >
              Leads admin
            </Link>
          )}
        </div>

        <div aria-live="polite" className="mb-3 flex flex-col gap-2">
          <Alert error={acknowledge.error} />
          {acknowledge.isSuccess && acknowledge.data.acknowledged && (
            <Notice>Lead acknowledged.</Notice>
          )}
          {acknowledge.isSuccess && !acknowledge.data.acknowledged && (
            <Alert
              error={new Error('That lead could not be acknowledged. It may have been reassigned.')}
            />
          )}
        </div>

        {leads.isPending && <Loading>Loading leads…</Loading>}
        {leads.error !== null && (
          <div className="flex flex-col gap-3">
            <Alert error={leads.error} />
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void leads.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        )}
        {leads.data !== undefined && leads.data.items.length === 0 && (
          <Empty>No leads match.</Empty>
        )}
        {leads.data !== undefined && leads.data.items.length > 0 && (
          <>
            <ul className="flex flex-col gap-2">
              {leads.data.items.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  nowMs={nowMs}
                  canAcknowledge={lead.assigneeMembershipId === myId}
                  acknowledging={acknowledge.isPending && acknowledge.variables === lead.id}
                  onAcknowledge={(leadId) => {
                    acknowledge.mutate(leadId);
                  }}
                />
              ))}
            </ul>
            <Pager pageInfo={leads.data.pageInfo} onPage={setPage} />
          </>
        )}
      </Card>
    </PageContainer>
  );
}
