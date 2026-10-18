import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Card, Empty, Loading } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { toMinorUnits } from '../../lib/format.js';
import { useSession } from '../auth/session.js';
import { PaymentRow } from './PaymentRow.js';
import { useOpportunityPayments, useRequestPayment } from './payments-api.js';

/** The Payments section on an opportunity: list, and request a new payment (I2.1). */
export function OpportunityPayments({
  opportunityId,
  defaultCurrency,
}: {
  opportunityId: string;
  defaultCurrency?: string | null;
}) {
  const session = useSession();
  const payments = useOpportunityPayments(opportunityId);
  const request = useRequestPayment(opportunityId);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency ?? 'USD');
  const [description, setDescription] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const canRequest = session.data?.membership.permissions.includes(PERMISSIONS.CRM_EDIT) ?? false;
  const fieldErrors = request.error instanceof ApiError ? (request.error.fields ?? {}) : {};

  return (
    <Card id="payments" title="Payments">
      {payments.isPending && <Loading>Loading payments…</Loading>}
      <Alert error={payments.error} />
      {payments.data?.items.length === 0 && <Empty>No payments requested yet.</Empty>}
      {payments.data !== undefined && payments.data.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {payments.data.items.map((payment) => (
            <PaymentRow key={payment.id} payment={payment} />
          ))}
        </ul>
      )}

      {canRequest && (
        <form
          noValidate
          className="mt-5 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const minor = toMinorUnits(amount);
            if (minor === null) {
              setLocalError('Enter an amount greater than zero, for example 150.00.');
              return;
            }
            if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
              setLocalError('Currency must be a 3-letter code such as USD.');
              return;
            }
            setLocalError(null);
            request.mutate(
              {
                amount: minor,
                currency: currency.trim().toUpperCase(),
                ...(description.trim() === '' ? {} : { description: description.trim() }),
              },
              {
                onSuccess: () => {
                  setAmount('');
                  setDescription('');
                },
              },
            );
          }}
        >
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            Request a payment
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              error={fieldErrors['amount']}
            />
            <Field
              label="Currency"
              maxLength={3}
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
              }}
              error={fieldErrors['currency']}
            />
            <Field
              label="Description"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </div>
          <div aria-live="polite" className="flex flex-col gap-2">
            {localError !== null && <Alert error={new Error(localError)} />}
            <Alert error={request.error} />
            {request.isSuccess && (
              <Notice>
                Payment requested.{' '}
                {request.data.checkoutUrl != null && (
                  <a
                    href={request.data.checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Open payment page
                  </a>
                )}
              </Notice>
            )}
          </div>
          <div>
            <Button type="submit" busy={request.isPending} busyLabel="Requesting…">
              Request payment
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
