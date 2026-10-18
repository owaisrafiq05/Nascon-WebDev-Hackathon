import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Select } from '../../components/Select.js';
import {
  DASHBOARD_RANGES,
  RANGE_LABELS,
  drillDownHref,
  parseAvailabilityDetail,
  parseStageDetail,
  useDashboard,
  useSaveDashboardPreferences,
  type DashboardRange,
  type DashboardTile,
} from './dashboard-api.js';

/** The home screen: figures that matter now, each linking to the records behind it. */
export function Dashboard() {
  const [range, setRange] = useState<DashboardRange>('today');
  const [customizing, setCustomizing] = useState(false);
  const dashboard = useDashboard(range);
  const save = useSaveDashboardPreferences();

  const data = dashboard.data;
  const hidden = data?.hiddenTiles ?? [];
  const visible = (data?.tiles ?? []).filter((tile) => !hidden.includes(tile.id));

  function toggle(tileId: string, show: boolean): void {
    const next = show ? hidden.filter((id) => id !== tileId) : [...hidden, tileId];
    save.mutate(next);
  }

  return (
    <section aria-labelledby="dashboard-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            id="dashboard-heading"
            className="text-2xl font-bold text-slate-900 dark:text-slate-50"
          >
            Dashboard
          </h1>
          {data !== undefined && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {data.scope === 'company' ? 'Whole company' : 'Your own figures'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Range"
            value={range}
            onChange={(event) => {
              setRange(event.target.value as DashboardRange);
            }}
          >
            {DASHBOARD_RANGES.map((value) => (
              <option key={value} value={value}>
                {RANGE_LABELS[value]}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            aria-expanded={customizing}
            aria-controls="dashboard-customize"
            onClick={() => {
              setCustomizing((open) => !open);
            }}
          >
            Customize
          </Button>
        </div>
      </div>

      {customizing && data !== undefined && (
        <fieldset
          id="dashboard-customize"
          className="mt-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
        >
          <legend className="px-1 text-sm font-semibold">Show these tiles</legend>
          <ul className="mt-1 flex flex-col gap-2">
            {data.tiles.map((tile) => (
              <li key={tile.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!hidden.includes(tile.id)}
                    disabled={save.isPending}
                    onChange={(event) => {
                      toggle(tile.id, event.target.checked);
                    }}
                  />
                  {tile.label}
                </label>
              </li>
            ))}
          </ul>
          <div aria-live="polite" className="mt-3">
            {save.isPending && (
              <p role="status" className="text-sm">
                Saving…
              </p>
            )}
            <Alert error={save.error} />
            {save.isSuccess && <Notice>Dashboard saved.</Notice>}
          </div>
        </fieldset>
      )}

      <div className="mt-4">
        {dashboard.isPending && <Skeletons />}
        {dashboard.error !== null && (
          <div className="flex flex-col gap-3">
            <Alert error={dashboard.error} />
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void dashboard.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        )}
        {data !== undefined && visible.length === 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            All tiles are hidden. Use Customize to show some.
          </p>
        )}
        {data !== undefined && visible.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((tile) => (
              <li key={tile.id}>
                <Tile tile={tile} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Skeletons() {
  return (
    <div role="status" aria-label="Loading dashboard">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <li
            key={n}
            className="h-28 animate-pulse rounded-xl bg-slate-200 dark:bg-slate-800"
            aria-hidden="true"
          />
        ))}
      </ul>
      <span className="sr-only">Loading dashboard…</span>
    </div>
  );
}

function Tile({ tile }: { tile: DashboardTile }) {
  const stages = tile.id === 'open_pipeline_value' ? parseStageDetail(tile.detail) : null;
  const availability = tile.id === 'availability' ? parseAvailabilityDetail(tile.detail) : null;
  const href =
    tile.drillDown === null || tile.drillDown === undefined ? null : drillDownHref(tile.drillDown);

  return (
    <article className="h-full rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <h2 className="text-sm font-medium text-slate-600 dark:text-slate-400">
        {href === null ? (
          tile.label
        ) : (
          <Link
            to={href}
            className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:focus-visible:ring-slate-100"
          >
            {tile.label}
          </Link>
        )}
      </h2>
      <p className="mt-1 text-2xl font-bold break-words text-slate-900 dark:text-slate-50">
        {tile.display}
      </p>
      {tile.description !== '' && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{tile.description}</p>
      )}

      {stages !== null && stages.byStage.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {stages.byStage.map((stage) => (
            <li key={stage.stageId} className="flex justify-between gap-2">
              <span className="min-w-0 break-words">{stage.stageName}</span>
              <span className="font-medium">{stage.display}</span>
            </li>
          ))}
        </ul>
      )}

      {availability !== null && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <li>Available: {availability.available}</li>
          <li>Busy: {availability.busy}</li>
          <li>On leave: {availability.on_leave}</li>
          <li>Offline: {availability.offline}</li>
        </ul>
      )}
    </article>
  );
}
