import { Alert, Notice } from '../../components/Alert.js';
import { Badge, LINK_CLASS } from '../../components/ui.js';
import { Button } from '../../components/Button.js';
import { formatDateTime, formatMoney } from '../../lib/format.js';
import { PAYMENT_STATUS_LABELS, useSendPaymentLink, type Payment } from './payments-api.js';

/** One payment: amount, status in words, the hosted payment link (I2). */
export function PaymentRow({ payment, canSend = true }: { payment: Payment; canSend?: boolean }) {
  const send = useSendPaymentLink();
  const tone =
    payment.status === 'paid'
      ? 'good'
      : payment.status === 'failed'
        ? 'bad'
        : payment.status === 'pending'
          ? 'neutral'
          : 'warn';
  const symbol = payment.status === 'paid' ? '✓' : payment.status === 'failed' ? '!' : '•';

  return (
    <li className="rounded-lg border border-slate-300 bg-white px-4 py-3 shadow-[0_1px_0_rgba(26,22,18,0.04)] transition-colors duration-150 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:shadow-none dark:hover:border-slate-500">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-slate-900 dark:text-slate-100">
          {formatMoney(payment.amount, payment.currency)}
        </p>
        <Badge tone={tone} symbol={symbol}>
          {PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}
        </Badge>
      </div>
      <p className="text-sm break-words text-slate-600 dark:text-slate-400">
        {payment.description ?? 'No description'}
        {payment.opportunityName != null && ` · ${payment.opportunityName}`}
        {payment.contactName != null && ` · ${payment.contactName}`}
      </p>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Requested {formatDateTime(payment.createdAt)}
        {payment.paidAt != null && ` · Paid ${formatDateTime(payment.paidAt)}`}
        {payment.refundedAmount != null &&
          payment.refundedAmount > 0 &&
          ` · Refunded ${formatMoney(payment.refundedAmount, payment.currency)}`}
      </p>
      {payment.failureReason != null && (
        <p className="text-sm text-red-800 dark:text-red-300">Reason: {payment.failureReason}</p>
      )}
      {payment.status === 'pending' && payment.checkoutUrl != null && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <a
            href={payment.checkoutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-sm ${LINK_CLASS}`}
          >
            Open payment page
          </a>
          {canSend && (
            <Button
              type="button"
              variant="secondary"
              busy={send.isPending}
              busyLabel="Sending…"
              onClick={() => {
                send.mutate(payment.id);
              }}
            >
              Send link to customer
            </Button>
          )}
        </div>
      )}
      <div aria-live="polite" className="mt-2">
        <Alert error={send.error} />
        {send.isSuccess && send.data.sent && <Notice>Payment link sent to the customer.</Notice>}
      </div>
    </li>
  );
}
