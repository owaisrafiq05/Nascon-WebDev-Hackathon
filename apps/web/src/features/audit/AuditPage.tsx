import { ALL_AUDIT_EVENT_TYPES, PERMISSIONS } from '@ubmp/domain';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { apiRequest } from '../../lib/api.js';
import { useMembers } from '../team/team-api.js';

/**
 * The audit log viewer (F4.2), with filters by event type, acting user and date
 * range, paginated.
 *
 * The route that renders this is already guarded by the `audit_log.view`
 * permission, so reaching it without the permission is not possible; the server
 * refuses the request as well (F1.5).
 */
const auditPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      at: z.string(),
      actor: z.object({
        kind: z.enum(['user', 'system']),
        userId: z.string().nullable(),
        label: z.string(),
      }),
      target: z.object({
        kind: z.string(),
        id: z.string().nullable(),
        label: z.string(),
      }),
      before: z.record(z.string(), z.unknown()).nullable(),
      after: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  pageInfo: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  }),
});

interface Filters {
  readonly type: string;
  readonly actorUserId: string;
  readonly from: string;
  readonly to: string;
  readonly page: number;
}

const EMPTY_FILTERS: Filters = { type: '', actorUserId: '', from: '', to: '', page: 1 };

function buildQuery(filters: Filters): string {
  const params = new URLSearchParams({ page: String(filters.page), limit: '25' });

  if (filters.type !== '') params.set('types', filters.type);
  if (filters.actorUserId !== '') params.set('actorUserId', filters.actorUserId);
  // The inputs are dates; the API wants instants, so each end is widened to
  // cover the whole day in the viewer's own time zone.
  if (filters.from !== '') params.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to !== '') params.set('to', new Date(`${filters.to}T23:59:59.999`).toISOString());

  return params.toString();
}

export function AuditPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const members = useMembers();

  const events = useQuery({
    queryKey: ['audit-events', filters],
    queryFn: () => apiRequest(`/api/audit-events?${buildQuery(filters)}`, auditPageSchema),
  });

  /**
   * Changing any filter returns to page 1, so the user is never left looking at
   * page 4 of a result that now has two pages.
   */
  const setFilter = (key: 'type' | 'actorUserId' | 'from' | 'to', value: string): void => {
    setFilters((current) => ({ ...current, [key]: value, page: 1 }));
  };

  const goToPage = (page: number): void => {
    setFilters((current) => ({ ...current, page }));
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Audit log</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Every important change, with who made it and when. Entries can never be edited or removed.
      </p>

      <section
        aria-labelledby="filters-heading"
        className="mt-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
      >
        <h2 id="filters-heading" className="sr-only">
          Filters
        </h2>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="filter-type"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Event type
            </label>
            <select
              id="filter-type"
              value={filters.type}
              onChange={(event) => {
                setFilter('type', event.target.value);
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">All types</option>
              {ALL_AUDIT_EVENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="filter-actor"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Who acted
            </label>
            <select
              id="filter-actor"
              value={filters.actorUserId}
              onChange={(event) => {
                setFilter('actorUserId', event.target.value);
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">Anyone</option>
              {(members.data?.members ?? []).map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.email}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="filter-from"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              From
            </label>
            <input
              id="filter-from"
              type="date"
              value={filters.from}
              onChange={(event) => {
                setFilter('from', event.target.value);
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="filter-to"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              To
            </label>
            <input
              id="filter-to"
              type="date"
              value={filters.to}
              onChange={(event) => {
                setFilter('to', event.target.value);
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div className="mt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
            }}
          >
            Clear filters
          </Button>
        </div>
      </section>

      <div aria-live="polite" className="mt-6">
        {events.isPending && (
          <p className="text-sm text-slate-600 dark:text-slate-400">Loading the audit log…</p>
        )}
        <Alert error={events.error} />

        {events.data !== undefined && events.data.items.length === 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            No entries match those filters.
          </p>
        )}
      </div>

      {events.data !== undefined && events.data.items.length > 0 && (
        <>
          {/* Scrolls inside itself, so the page never scrolls sideways (Q7). */}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <caption className="sr-only">
                Audit entries, newest first, page {events.data.pageInfo.page} of{' '}
                {events.data.pageInfo.totalPages}
              </caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    When
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Event
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Who
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Target
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Change
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.data.items.map((event) => (
                  <tr key={event.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2 pr-4 align-top whitespace-nowrap text-slate-700 dark:text-slate-300">
                      {new Date(event.at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 align-top font-mono text-xs text-slate-900 dark:text-slate-100">
                      {event.type}
                    </td>
                    <td className="py-2 pr-4 align-top text-slate-700 dark:text-slate-300">
                      {event.actor.kind === 'system' ? 'System' : event.actor.label}
                    </td>
                    <td className="py-2 pr-4 align-top break-all text-slate-700 dark:text-slate-300">
                      {event.target.label || event.target.kind}
                    </td>
                    <td className="py-2 align-top text-xs text-slate-600 dark:text-slate-400">
                      {event.before !== null && (
                        <div>
                          <span className="font-medium">before:</span>{' '}
                          {JSON.stringify(event.before)}
                        </div>
                      )}
                      {event.after !== null && (
                        <div>
                          <span className="font-medium">after:</span> {JSON.stringify(event.after)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav
            aria-label="Audit log pages"
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Page {events.data.pageInfo.page} of {events.data.pageInfo.totalPages} ·{' '}
              {events.data.pageInfo.total} entries
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={!events.data.pageInfo.hasPreviousPage}
                onClick={() => {
                  goToPage(filters.page - 1);
                }}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!events.data.pageInfo.hasNextPage}
                onClick={() => {
                  goToPage(filters.page + 1);
                }}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}

export const AUDIT_PERMISSION = PERMISSIONS.AUDIT_LOG_VIEW;
