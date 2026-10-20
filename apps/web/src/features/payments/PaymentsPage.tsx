import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Pager } from '../../components/Pager.js';
import { Select } from '../../components/Select.js';
import { Card, Empty, Loading, PageContainer, PageTitle } from '../../components/ui.js';
import { formatMoney } from '../../lib/format.js';
import { PaymentRow } from './PaymentRow.js';
import { PAYMENT_STATUS_LABELS, usePayments, usePaymentSummary } from './payments-api.js';

export function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const status = params.get('status') ?? '';
  const paidFrom = params.get('paidFrom') ?? '';
  const mine = params.get('mine') === 'true' ? 'true' : '';

  const payments = usePayments({ status, paidFrom, mine, page });
  const summary = usePaymentSummary();

  function update(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
    setPage(1);
  }

  return (
    <PageContainer>
      <PageTitle
        kicker="Work"
        sub="Money collected is shown separately from money still expected."
      >
        Payments
      </PageTitle>

      <Card id="summary" title="Summary">
        {summary.isPending && <Loading>Loading summary…</Loading>}
        <Alert error={summary.error} />
        {summary.data !== undefined && (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-slate-600 dark:text-slate-400">
                Collected (net)
              </dt>
              <dd className="font-mono text-2xl font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-50">
                {formatMoney(summary.data.collected.net, summary.data.currency)}
              </dd>
              <dd className="text-xs text-slate-600 dark:text-slate-400">
                {summary.data.collected.paymentCount} payments · gross{' '}
                {formatMoney(summary.data.collected.gross, summary.data.currency)} · refunded{' '}
                {formatMoney(summary.data.collected.refunded, summary.data.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-slate-600 dark:text-slate-400">
                Projected (not yet collected)
              </dt>
              <dd className="font-mono text-2xl font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-50">
                {formatMoney(summary.data.projected.total, summary.data.currency)}
              </dd>
              <dd className="text-xs text-slate-600 dark:text-slate-400">
                {summary.data.projected.openOpportunities ?? 0} open opportunities ·{' '}
                {summary.data.projected.unpaidRequests ?? 0} unpaid requests
              </dd>
            </div>
          </dl>
        )}
      </Card>

      <Card id="list" title="All payments">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Select
            label="Status"
            value={status}
            onChange={(event) => {
              update('status', event.target.value);
            }}
          >
            <option value="">All statuses</option>
            {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={mine === 'true'}
              onChange={(event) => {
                update('mine', event.target.checked ? 'true' : '');
              }}
            />
            Only payments I requested
          </label>
          {paidFrom !== '' && (
            <>
              <p className="text-sm">Paid since {new Date(paidFrom).toLocaleString()}</p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  update('paidFrom', '');
                }}
              >
                Clear date filter
              </Button>
            </>
          )}
        </div>

        {payments.isPending && <Loading>Loading payments…</Loading>}
        {payments.error !== null && (
          <div className="flex flex-col gap-3">
            <Alert error={payments.error} />
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void payments.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        )}
        {payments.data?.items.length === 0 && <Empty>No payments match.</Empty>}
        {payments.data !== undefined && payments.data.items.length > 0 && (
          <>
            <ul className="flex flex-col gap-2">
              {payments.data.items.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} />
              ))}
            </ul>
            <Pager pageInfo={payments.data.pageInfo} onPage={setPage} />
          </>
        )}
      </Card>
    </PageContainer>
  );
}
