import {
  AUDIT_EVENT_TYPES,
  availableEmployeeCount,
  averageTimeToFirstResponse,
  canViewOpportunityValue,
  escalationCount,
  newLeadCount,
  openPipelineValue,
  paymentsReceived,
  PERMISSIONS,
  upcomingAppointmentCount,
  type Period,
  type ReassignmentKind,
} from '@ubmp/domain';
import type { Types } from 'mongoose';

import { AppointmentModel } from '../db/models/appointment.js';
import { AuditEventModel } from '../db/models/audit-event.js';
import { LeadModel } from '../db/models/lead.js';
import { MembershipModel } from '../db/models/membership.js';
import { OpportunityModel } from '../db/models/opportunity.js';
import { PaymentModel } from '../db/models/payment.js';
import { PipelineModel } from '../db/models/pipeline.js';
import { paymentRecordOf } from './payment-service.js';
import { recoveryQueueFor } from './recovery-service.js';
import { settingsFor } from './lead-service.js';
import type { AuthContext } from './session-service.js';

/**
 * The operational dashboard (F5.1 - F5.5).
 *
 * Every figure is computed by a function in `packages/domain/src/metrics.ts`;
 * this module only loads the records the caller may see and hands them over.
 * Drill-downs name the list page and the exact query that reproduces the
 * figure's records, so the number and the list cannot disagree (F5.2, Q12).
 */
export const DASHBOARD_TILES = [
  'new_leads',
  'open_pipeline_value',
  'avg_first_response',
  'recovery_queue',
  'escalations_24h',
  'availability',
  'upcoming_appointments',
  'payments_this_month',
] as const;
export type DashboardTile = (typeof DASHBOARD_TILES)[number];

export const DASHBOARD_RANGES = ['today', '7d', '30d'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Midnight of `now`'s day in `timeZone`, as an instant. */
export function startOfDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(now);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const elapsed = (value('hour') * 3_600 + value('minute') * 60 + value('second')) * 1_000;
  return new Date(Math.floor((now.getTime() - elapsed) / 1_000) * 1_000);
}

/** Start of the calendar month of `now` in `timeZone`. */
export function startOfMonth(now: Date, timeZone: string): Date {
  const day = Number(new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric' }).format(now));
  return startOfDay(new Date(now.getTime() - (day - 1) * DAY_MS), timeZone);
}

export function periodFor(range: DashboardRange, now: Date, timeZone: string): Period {
  const today = startOfDay(now, timeZone).getTime();
  const from = range === 'today' ? today : today - (range === '7d' ? 6 : 29) * DAY_MS;
  return { from, to: now.getTime() + 1 };
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'No responses yet';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

export function formatAmount(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

export interface Tile {
  readonly id: DashboardTile;
  readonly label: string;
  readonly value: number | null;
  readonly display: string;
  readonly description: string;
  readonly drillDown: { readonly path: string; readonly query: Record<string, string> } | null;
  readonly detail?: unknown;
}

export async function dashboardFor(
  auth: AuthContext,
  range: DashboardRange,
  timeZone: string,
  now: Date = new Date(),
) {
  const workspaceId: Types.ObjectId = auth.workspaceId;
  // F5.4: Owner and Admin (who manage members) see the company; a User sees their own.
  const company = auth.permissions.has(PERMISSIONS.MEMBERS_MANAGE);
  const me = auth.membershipId;
  const settings = await settingsFor(workspaceId);
  const currency = settings.currency;
  const period = periodFor(range, now, timeZone);
  const dayAgo: Period = { from: now.getTime() - DAY_MS, to: now.getTime() + 1 };
  const month: Period = { from: startOfMonth(now, timeZone).getTime(), to: now.getTime() + 1 };

  const leadScope = company ? {} : { assigneeMembershipId: me };
  const [
    leads,
    opportunities,
    pipelines,
    recovery,
    escalationEvents,
    memberships,
    appointments,
    payments,
    membership,
  ] = await Promise.all([
    LeadModel.find({ workspaceId, ...leadScope, createdAt: { $gte: new Date(period.from) } })
      .select('createdAt firstAssignedAt firstAcknowledgedAt')
      .lean(),
    OpportunityModel.find({
      workspaceId,
      stageOutcome: 'open',
      currency,
      ...(company ? {} : { ownerMembershipId: me }),
    })
      .select('stageId stageOutcome value currency')
      .lean(),
    PipelineModel.find({ workspaceId }).select('stages').lean(),
    recoveryQueueFor(workspaceId, now),
    AuditEventModel.find({
      workspaceId,
      type: {
        $in: [
          AUDIT_EVENT_TYPES.LEAD_ESCALATED,
          AUDIT_EVENT_TYPES.LEAD_REASSIGNED_MANUAL,
          AUDIT_EVENT_TYPES.LEAD_REASSIGNED_ABSENCE,
        ],
      },
      at: { $gte: new Date(dayAgo.from) },
      ...(company
        ? {}
        : {
            $or: [
              { 'after.assigneeMembershipId': me.toString() },
              { 'before.assigneeMembershipId': me.toString() },
            ],
          }),
    })
      .select('type at')
      .lean(),
    MembershipModel.find({ workspaceId }).select('availabilityStatus openLeadCount').lean(),
    AppointmentModel.find({
      workspaceId,
      status: 'scheduled',
      startsAt: { $gte: now },
      ...(company ? {} : { employeeMembershipId: me }),
    })
      .select('startsAt status')
      .lean(),
    PaymentModel.find({
      workspaceId,
      currency,
      paidAt: { $gte: new Date(month.from) },
      ...(company ? {} : { requestedByMembershipId: me }),
    }).lean(),
    MembershipModel.findOne({ _id: me, workspaceId }).select('dashboardHiddenTiles').lean(),
  ]);

  const stageNames = new Map<string, string>();
  for (const pipeline of pipelines)
    for (const stage of pipeline.stages) stageNames.set(stage.id, stage.name);

  // --- Figures, each from its Section 7 function --------------------------
  const newLeads = newLeadCount(
    leads.map((lead) => ({ createdAt: lead.createdAt.getTime() })),
    period,
  );

  const response = averageTimeToFirstResponse(
    leads.map((lead) => ({
      firstAssignedAt: lead.firstAssignedAt?.getTime() ?? null,
      firstAcknowledgedAt: lead.firstAcknowledgedAt?.getTime() ?? null,
    })),
  );

  const pipeline = openPipelineValue(
    opportunities.map((opportunity) => ({
      stageId: opportunity.stageId,
      stageOutcome: opportunity.stageOutcome,
      value: opportunity.value ?? 0,
      currency: opportunity.currency ?? currency,
    })),
    { currency },
  );
  const canSeeValues = canViewOpportunityValue(auth.permissions);

  const myRecovery = company
    ? recovery
    : recovery.filter((item) => item.assigneeMembershipId === me.toString());

  const kindOf: Record<string, ReassignmentKind> = {
    [AUDIT_EVENT_TYPES.LEAD_ESCALATED]: 'escalation',
    [AUDIT_EVENT_TYPES.LEAD_REASSIGNED_MANUAL]: 'manual',
    [AUDIT_EVENT_TYPES.LEAD_REASSIGNED_ABSENCE]: 'absence',
  };
  const reassignments = escalationEvents.map((event) => ({
    at: event.at.getTime(),
    kind: kindOf[event.type] ?? 'manual',
  }));
  const escalations = escalationCount(reassignments, dayAgo);
  const manualReassignments = reassignments.filter((entry) => entry.kind !== 'escalation').length;

  const statusCounts = { available: 0, busy: 0, on_leave: 0, offline: 0 };
  for (const entry of memberships) statusCounts[entry.availabilityStatus] += 1;
  const availableForAssignment = availableEmployeeCount(
    memberships.map((entry) => ({
      status: entry.availabilityStatus,
      openLeadCount: entry.openLeadCount,
    })),
    { maxOpenLeadsPerEmployee: settings.maxOpenLeadsPerEmployee },
  );

  const upcoming = upcomingAppointmentCount(
    appointments.map((appointment) => ({
      startsAt: appointment.startsAt.getTime(),
      status: appointment.status,
    })),
    now.getTime(),
  );

  const received = paymentsReceived(
    payments.map((payment) => ({
      ...paymentRecordOf(payment),
      paidAt: payment.paidAt?.getTime() ?? null,
    })),
    month,
    { currency },
  );

  const mine: Record<string, string> = company ? {} : { mine: 'true' };
  const scopeWord = company ? 'across the company' : 'assigned to you';

  const tiles: Tile[] = [
    {
      id: 'new_leads',
      label: range === 'today' ? 'New leads today' : `New leads (${range})`,
      value: newLeads,
      display: String(newLeads),
      description: `Leads captured ${scopeWord} in this period.`,
      drillDown: {
        path: '/leads',
        query: { createdFrom: new Date(period.from).toISOString(), status: 'all', ...mine },
      },
    },
    {
      id: 'open_pipeline_value',
      label: 'Open pipeline value',
      value: canSeeValues ? pipeline.total : null,
      display: canSeeValues ? formatAmount(pipeline.total, currency) : 'Hidden',
      description: canSeeValues
        ? `${String(pipeline.count)} open opportunities in ${currency}, by stage.`
        : 'You do not have permission to see opportunity values.',
      drillDown: { path: '/pipeline', query: {} },
      detail: {
        byStage: pipeline.byStage.map((stage) => ({
          stageId: stage.stageId,
          stageName: stageNames.get(stage.stageId) ?? stage.stageId,
          count: stage.count,
          total: canSeeValues ? stage.total : null,
          display: canSeeValues ? formatAmount(stage.total, currency) : 'Hidden',
        })),
      },
    },
    {
      id: 'avg_first_response',
      label: company ? 'Average time to first response' : 'Your average time to first response',
      value: response.averageMs,
      display: formatDuration(response.averageMs),
      description: `From first assignment to first acknowledgement, over ${String(response.sampleSize)} leads in this period (${String(response.excluded)} not yet acknowledged).`,
      drillDown: null,
    },
    {
      id: 'recovery_queue',
      label: 'Recovery queue',
      value: myRecovery.length,
      display: String(myRecovery.length),
      description: 'Leads overdue, escalated repeatedly or idle too long.',
      drillDown: { path: '/recovery', query: {} },
    },
    {
      id: 'escalations_24h',
      label: 'Escalations, last 24 hours',
      value: escalations,
      display: String(escalations),
      description: `Automatic escalations only; ${String(manualReassignments)} manual or absence reassignments are counted separately.`,
      drillDown: auth.permissions.has(PERMISSIONS.AUDIT_LOG_VIEW)
        ? {
            path: '/audit',
            query: {
              types: AUDIT_EVENT_TYPES.LEAD_ESCALATED,
              from: new Date(dayAgo.from).toISOString(),
            },
          }
        : null,
      detail: { manualReassignments },
    },
    {
      id: 'availability',
      label: 'Employee availability',
      value: statusCounts.available,
      display: `${String(statusCounts.available)} available`,
      description: `${String(availableForAssignment)} can take a new lead now (Available and under the limit of ${String(settings.maxOpenLeadsPerEmployee)}).`,
      drillDown: company ? { path: '/leads/manage', query: {} } : null,
      detail: { ...statusCounts, availableForAssignment },
    },
    {
      id: 'upcoming_appointments',
      label: 'Upcoming appointments',
      value: upcoming,
      display: String(upcoming),
      description: `Scheduled appointments ${company ? 'for everyone' : 'with you'} from now on.`,
      drillDown: {
        path: '/appointments',
        query: { upcoming: 'true', ...(company ? {} : { employeeMembershipId: me.toString() }) },
      },
    },
    {
      id: 'payments_this_month',
      label: 'Payments received this month',
      value: received.net,
      display: formatAmount(received.net, currency),
      description: `Collected revenue confirmed by Stripe, net of ${formatAmount(received.refunded, currency)} refunded, from ${String(received.paymentCount)} payments.`,
      drillDown: {
        path: '/payments',
        query: { paidFrom: new Date(month.from).toISOString(), ...mine },
      },
    },
  ];

  return {
    range,
    scope: company ? ('company' as const) : ('personal' as const),
    currency,
    generatedAt: now.toISOString(),
    hiddenTiles: membership?.dashboardHiddenTiles ?? [],
    tiles,
  };
}
