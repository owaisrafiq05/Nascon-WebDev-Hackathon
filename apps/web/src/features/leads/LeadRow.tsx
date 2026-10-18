import { Button } from '../../components/Button.js';
import { Badge, ROW_CLASS } from '../../components/ui.js';
import { formatCountdown, humanize } from '../../lib/format.js';
import type { Lead } from './leads-api.js';

const ASSIGNMENT_LABELS: Record<string, string> = {
  pending_ack: 'Waiting for acknowledgement',
  escalated: 'Escalated, waiting for acknowledgement',
  acknowledged: 'Acknowledged',
  unassigned: 'Unassigned',
};

export function assignmentLabel(lead: Lead): string {
  const code = lead.assignmentStatus;
  if (code === null || code === undefined) return humanize(lead.status);
  return ASSIGNMENT_LABELS[code] ?? humanize(code);
}

/** One lead in the inbox: source, status in words, owner, live countdown. */
export function LeadRow({
  lead,
  nowMs,
  canAcknowledge,
  acknowledging,
  onAcknowledge,
}: {
  lead: Lead;
  nowMs: number;
  canAcknowledge: boolean;
  acknowledging: boolean;
  onAcknowledge: (leadId: string) => void;
}) {
  const waiting =
    (lead.acknowledgedAt === null || lead.acknowledgedAt === undefined) &&
    lead.assignmentStatus !== 'acknowledged' &&
    lead.status === 'open';
  const countdown = waiting ? formatCountdown(lead.acknowledgementDeadline, nowMs) : null;
  const sourceLabel = lead.sourceLabel ?? lead.source ?? 'Unknown source';

  return (
    <li className={ROW_CLASS}>
      <div className="min-w-0">
        <p className="font-medium break-words text-slate-900 dark:text-slate-100">{sourceLabel}</p>
        <p className="text-sm break-all text-slate-600 dark:text-slate-400">
          Assigned to: {lead.assigneeEmail ?? 'Nobody'}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <span>Status: {assignmentLabel(lead)}</span>
          {(lead.escalationCount ?? 0) > 0 && (
            <Badge tone="warn" symbol="▲">
              Escalated {lead.escalationCount} time{lead.escalationCount === 1 ? '' : 's'}
            </Badge>
          )}
          {lead.ownerUnavailable === true && (
            <Badge tone="bad" symbol="!">
              Owner unavailable
            </Badge>
          )}
          {countdown !== null && (
            <Badge tone={countdown === 'Overdue' ? 'bad' : 'neutral'} symbol="⏱">
              {countdown}
            </Badge>
          )}
        </p>
      </div>
      {canAcknowledge && waiting && (
        <Button
          type="button"
          busy={acknowledging}
          busyLabel="Acknowledging…"
          aria-label={`Acknowledge lead from ${sourceLabel}`}
          onClick={() => {
            onAcknowledge(lead.id);
          }}
        >
          Acknowledge
        </Button>
      )}
    </li>
  );
}
