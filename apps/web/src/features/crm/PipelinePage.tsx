import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { useSession } from '../auth/session.js';
import { usePipelines } from './crm-api.js';
import { OpportunityList } from './OpportunityList.js';
import { PipelineBoard } from './PipelineBoard.js';

/**
 * The pipeline, as a board or a list (F2.5).
 *
 * Both views move opportunities between stages; the board adds dragging, and
 * the list is the denser read. The choice is remembered only for this visit:
 * a persisted preference belongs with the dashboard preferences in P5.
 */
export function PipelinePage() {
  const session = useSession();
  const pipelines = usePipelines();

  const [view, setView] = useState<'board' | 'list'>('board');
  const [pipelineId, setPipelineId] = useState<string | null>(null);

  const permissions = session.data?.membership.permissions ?? [];
  const canEdit = permissions.includes(PERMISSIONS.CRM_EDIT);

  const available = pipelines.data?.pipelines ?? [];
  const selected = available.find((pipeline) => pipeline.id === pipelineId) ?? available[0];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Pipeline</h1>

        <div className="flex flex-wrap items-center gap-3">
          {available.length > 1 && (
            <div className="flex items-center gap-2">
              <label
                htmlFor="pipeline-select"
                className="text-sm text-slate-600 dark:text-slate-400"
              >
                Pipeline
              </label>
              <select
                id="pipeline-select"
                value={selected?.id ?? ''}
                onChange={(event) => {
                  setPipelineId(event.target.value);
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              >
                {available.map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>
                    {pipeline.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* A pressed state rather than colour alone, so the active view is
              announced and visible without relying on hue (Q8). */}
          <div role="group" aria-label="View" className="flex gap-1">
            <Button
              type="button"
              variant={view === 'board' ? 'primary' : 'secondary'}
              aria-pressed={view === 'board'}
              onClick={() => {
                setView('board');
              }}
            >
              Board
            </Button>
            <Button
              type="button"
              variant={view === 'list' ? 'primary' : 'secondary'}
              aria-pressed={view === 'list'}
              onClick={() => {
                setView('list');
              }}
            >
              List
            </Button>
          </div>
        </div>
      </div>

      <div aria-live="polite" className="mt-4">
        {pipelines.isPending && (
          <p className="text-sm text-slate-600 dark:text-slate-400">Loading pipelines…</p>
        )}
        <Alert error={pipelines.error} />
      </div>

      {selected !== undefined && (
        <div className="mt-6">
          {view === 'board' ? (
            <PipelineBoard pipeline={selected} canEdit={canEdit} />
          ) : (
            <OpportunityList pipeline={selected} canEdit={canEdit} />
          )}
        </div>
      )}
    </div>
  );
}
