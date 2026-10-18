import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { ApiError } from '../../lib/api.js';
import {
  useMoveOpportunity,
  useOpportunities,
  type Opportunity,
  type Pipeline,
  type Stage,
} from './crm-api.js';
import { MoveToStageMenu } from './MoveToStageMenu.js';

/**
 * The kanban board (F2.5).
 *
 * Drag and drop is the pointer affordance; it is **not** the only one. Every
 * card also carries a "Move to" menu that does the same thing from the
 * keyboard, because a drag cannot be performed without a pointer and Q8
 * requires every interactive element to be usable with a keyboard. The menu is
 * always visible rather than appearing on hover, so it is reachable by Tab.
 *
 * At narrow widths the columns stack into a single scrolling list rather than
 * forcing the page sideways (Q7).
 */
export interface PipelineBoardProps {
  readonly pipeline: Pipeline;
  readonly canEdit: boolean;
}

export function PipelineBoard({ pipeline, canEdit }: PipelineBoardProps) {
  const opportunities = useOpportunities({ pipelineId: pipeline.id, limit: '100' });
  const move = useMoveOpportunity();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetStageId, setDropTargetStageId] = useState<string | null>(null);

  const byStage = new Map<string, Opportunity[]>();
  for (const stage of pipeline.stages) byStage.set(stage.id, []);
  for (const opportunity of opportunities.data?.items ?? []) {
    byStage.get(opportunity.stageId)?.push(opportunity);
  }

  const moveTo = (opportunity: Opportunity, stageId: string): void => {
    if (opportunity.stageId === stageId) return;
    move.mutate({ id: opportunity.id, stageId, version: opportunity.version });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* A blocked move reports exactly which fields are missing (F2.4). */}
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
      </div>

      {opportunities.isPending && (
        <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
          Loading the board…
        </p>
      )}
      <Alert error={opportunities.error} />

      {/*
        One column per stage on a wide screen; stacked on a phone. `overflow-x`
        is on this container, so the board scrolls inside itself and the page
        never scrolls sideways (Q7).
      */}
      <div className="flex flex-col gap-4 md:flex-row md:overflow-x-auto md:pb-2">
        {pipeline.stages.map((stage) => {
          const cards = byStage.get(stage.id) ?? [];
          const isDropTarget = dropTargetStageId === stage.id;

          return (
            <section
              key={stage.id}
              aria-labelledby={`stage-${stage.id}`}
              className={`flex min-w-0 flex-col gap-2 rounded-xl border p-3 md:w-72 md:shrink-0 ${
                isDropTarget
                  ? 'border-slate-900 bg-slate-100 dark:border-slate-100 dark:bg-slate-800'
                  : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'
              }`}
              onDragOver={(event) => {
                if (!canEdit || draggingId === null) return;
                // Required for a drop to be allowed at all.
                event.preventDefault();
                setDropTargetStageId(stage.id);
              }}
              onDragLeave={() => {
                setDropTargetStageId((current) => (current === stage.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDropTargetStageId(null);
                if (!canEdit || draggingId === null) return;

                const dragged = (opportunities.data?.items ?? []).find(
                  (candidate) => candidate.id === draggingId,
                );
                if (dragged !== undefined) moveTo(dragged, stage.id);
                setDraggingId(null);
              }}
            >
              <header className="flex items-baseline justify-between gap-2">
                <h3
                  id={`stage-${stage.id}`}
                  className="text-sm font-semibold text-slate-900 dark:text-slate-50"
                >
                  {stage.name}
                </h3>
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  {cards.length}
                  {/* The outcome is spelled out, not conveyed by colour (Q8). */}
                  {stage.outcome !== 'open' && ` · ${stage.outcome}`}
                </span>
              </header>

              <ul className="flex flex-col gap-2">
                {cards.map((opportunity) => (
                  <li
                    key={opportunity.id}
                    draggable={canEdit}
                    onDragStart={() => {
                      setDraggingId(opportunity.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDropTargetStageId(null);
                    }}
                    className={`rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800 ${
                      draggingId === opportunity.id ? 'opacity-50' : ''
                    }`}
                  >
                    <Link
                      to={`/opportunities/${opportunity.id}`}
                      className="block font-medium break-words text-slate-900 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:text-slate-100"
                    >
                      {opportunity.name}
                    </Link>

                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      {opportunity.valueMasked === true
                        ? 'Value hidden'
                        : opportunity.value === null
                          ? 'No value recorded'
                          : `${opportunity.currency ?? ''} ${(opportunity.value / 100).toFixed(2)}`}
                    </p>

                    {canEdit && (
                      <div className="mt-2">
                        <MoveToStageMenu
                          stages={pipeline.stages}
                          currentStageId={opportunity.stageId}
                          busy={move.isPending}
                          onMove={(stageId) => {
                            moveTo(opportunity, stageId);
                          }}
                          label={`Move ${opportunity.name} to`}
                        />
                      </div>
                    )}
                  </li>
                ))}

                {cards.length === 0 && (
                  <li className="rounded-lg border border-dashed border-slate-300 p-3 text-xs text-slate-500 dark:border-slate-600 dark:text-slate-400">
                    Nothing in this stage.
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export type { Stage };
