import type { DependencyStatus, HealthStatus } from '@ubmp/shared';

import { ApiError } from '../../lib/api.js';
import { useHealth } from './use-health.js';

/**
 * Renders the API's health. Every state the request can be in is shown (Q10), and
 * each status carries a word and a symbol as well as a colour, so the meaning
 * survives for a colour-blind reader or a monochrome screen (Q8).
 */

const DEPENDENCY_LABEL: Record<DependencyStatus, { text: string; symbol: string; tone: string }> = {
  up: { text: 'Connected', symbol: '●', tone: 'text-emerald-700 dark:text-emerald-400' },
  connecting: { text: 'Connecting', symbol: '◐', tone: 'text-amber-700 dark:text-amber-400' },
  down: { text: 'Not connected', symbol: '○', tone: 'text-red-700 dark:text-red-400' },
};

const OVERALL_LABEL: Record<HealthStatus, string> = {
  ok: 'All systems operational',
  degraded: 'Running with a degraded dependency',
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-sm text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="font-mono text-sm break-all text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  );
}

export function SystemStatusCard() {
  const { data, error, isPending, isFetching, refetch } = useHealth();

  return (
    <section aria-labelledby="system-status-heading" className="max-w-xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="system-status-heading"
          className="font-mono text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-50"
        >
          API status
        </h2>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 dark:focus-visible:ring-brass-bright"
        >
          {isFetching ? 'Checking…' : 'Check again'}
        </button>
      </div>

      {/* Announce changes to anyone using a screen reader. */}
      <div aria-live="polite" className="mt-4">
        {isPending && (
          <p className="text-sm text-slate-600 dark:text-slate-400">Contacting the API…</p>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950"
          >
            <p className="text-sm font-medium text-red-900 dark:text-red-200">
              {'○'} {error.message}
            </p>
            {error instanceof ApiError && error.hint !== undefined && (
              <p className="mt-1 text-sm text-red-800 dark:text-red-300">{error.hint}</p>
            )}
          </div>
        )}

        {data && (
          <>
            <p
              className={
                data.status === 'ok'
                  ? 'text-sm font-medium text-emerald-700 dark:text-emerald-400'
                  : 'text-sm font-medium text-amber-700 dark:text-amber-400'
              }
            >
              {data.status === 'ok' ? '●' : '◐'} {OVERALL_LABEL[data.status]}
            </p>

            <dl className="mt-3 divide-y divide-slate-200 dark:divide-slate-700">
              <Row label="Service" value={data.service} />
              <Row label="Version" value={data.version} />
              <Row label="Environment" value={data.environment} />
              <Row label="Uptime" value={`${String(data.uptimeSeconds)}s`} />
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <dt className="text-sm text-slate-600 dark:text-slate-400">Database</dt>
                <dd
                  className={`text-sm font-medium ${DEPENDENCY_LABEL[data.dependencies.database].tone}`}
                >
                  {DEPENDENCY_LABEL[data.dependencies.database].symbol}{' '}
                  {DEPENDENCY_LABEL[data.dependencies.database].text}
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
