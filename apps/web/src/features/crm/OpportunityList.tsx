import { Link } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { Empty, LINK_CLASS } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { useMoveOpportunity, useOpportunities, type Pipeline } from './crm-api.js';
import { MoveToStageMenu } from './MoveToStageMenu.js';

/**
 * The pipeline as a table (F2.5): the same records and the same stage moves as
 * the board, in a denser form that reads better on a phone and with a screen
 * reader.
 */
export interface OpportunityListProps {
  readonly pipeline: Pipeline;
  readonly canEdit: boolean;
}

export function OpportunityList({ pipeline, canEdit }: OpportunityListProps) {
  const opportunities = useOpportunities({ pipelineId: pipeline.id, limit: '100' });
  const move = useMoveOpportunity();

  const stageNameById = new Map(pipeline.stages.map((stage) => [stage.id, stage.name]));

  return (
    <div className="flex flex-col gap-4">
      <div aria-live="polite">
        {move.error !== null && <Alert error={move.error} />}
        {move.error instanceof ApiError && move.error.fields !== undefined && (
          <ul className="mt-2 list-inside list-disc text-sm text-red-800 dark:text-red-300">
            {Object.entries(move.error.fields).map(([key, message]) => (
              <li key={key}>
                {key} {message}
              </li>
            ))}
          </ul>
        )}
        {opportunities.isPending && (
          <p className="text-sm text-slate-600 dark:text-slate-400">Loading opportunities…</p>
        )}
        <Alert error={opportunities.error} />
      </div>

      {opportunities.data !== undefined && opportunities.data.items.length === 0 && (
        <Empty>No opportunities in this pipeline yet.</Empty>
      )}

      {opportunities.data !== undefined && opportunities.data.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <caption className="sr-only">Opportunities in {pipeline.name}</caption>
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Stage
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Value
                </th>
                {canEdit && (
                  <th scope="col" className="py-2 font-semibold">
                    Move
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {opportunities.data.items.map((opportunity) => (
                <tr
                  key={opportunity.id}
                  className="border-b border-slate-100 dark:border-slate-800"
                >
                  <td className="py-2 pr-4">
                    <Link
                      to={`/opportunities/${opportunity.id}`}
                      className={`font-medium ${LINK_CLASS}`}
                    >
                      {opportunity.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">
                    {stageNameById.get(opportunity.stageId) ?? opportunity.stageId}
                  </td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">
                    {opportunity.valueMasked === true
                      ? 'Hidden'
                      : opportunity.value === null
                        ? '—'
                        : `${opportunity.currency ?? ''} ${(opportunity.value / 100).toFixed(2)}`}
                  </td>
                  {canEdit && (
                    <td className="py-2">
                      <MoveToStageMenu
                        stages={pipeline.stages}
                        currentStageId={opportunity.stageId}
                        busy={move.isPending}
                        label={`Move ${opportunity.name} to`}
                        onMove={(stageId) => {
                          if (stageId === opportunity.stageId) return;
                          move.mutate({
                            id: opportunity.id,
                            stageId,
                            version: opportunity.version,
                          });
                        }}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
