/**
 * Pipeline stage rules (F2.5).
 *
 * A pipeline is an ordered list of stages. Stage *identity* is a stable id, not
 * the name and not the position: renaming a stage or dragging it elsewhere must
 * not detach the opportunities sitting in it, which is exactly what would
 * happen if an opportunity stored a stage name or an index.
 */
import { STAGE_OUTCOMES, type StageOutcome } from './metrics.js';

export { STAGE_OUTCOMES, type StageOutcome };

export interface PipelineStage {
  readonly id: string;
  readonly name: string;
  /** 0-based display order. Kept contiguous by `reorderStages`. */
  readonly position: number;
  /**
   * Whether an opportunity in this stage is still in play, won, or lost.
   * Denormalised onto each opportunity so the open-pipeline-value metric can
   * exclude won and lost with an index (Section 7).
   */
  readonly outcome: StageOutcome;
}

/** The stages a new workspace starts with, so a pipeline is usable at once. */
export const DEFAULT_STAGES: readonly Omit<PipelineStage, 'id'>[] = [
  { name: 'New', position: 0, outcome: 'open' },
  { name: 'Qualifying', position: 1, outcome: 'open' },
  { name: 'Proposal', position: 2, outcome: 'open' },
  { name: 'Won', position: 3, outcome: 'won' },
  { name: 'Lost', position: 4, outcome: 'lost' },
];

export function findStage(
  stages: readonly PipelineStage[],
  stageId: string,
): PipelineStage | undefined {
  return stages.find((stage) => stage.id === stageId);
}

/** Stages in display order. The stored array's order is not relied on. */
export function sortedStages(stages: readonly PipelineStage[]): readonly PipelineStage[] {
  return [...stages].sort((left, right) => left.position - right.position);
}

/**
 * Re-numbers stages to match `orderedIds`, returning the new array.
 *
 * Positions are rewritten contiguously from 0 rather than nudged, so repeated
 * reorders cannot drift into gaps or ties that would make the board order
 * depend on insertion order.
 *
 * Any stage missing from `orderedIds` keeps its relative order and is appended,
 * so a reorder that was computed against a slightly stale list cannot drop a
 * stage.
 */
export function reorderStages(
  stages: readonly PipelineStage[],
  orderedIds: readonly string[],
): readonly PipelineStage[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const result: PipelineStage[] = [];

  for (const id of orderedIds) {
    const stage = byId.get(id);
    if (stage !== undefined && !result.includes(stage)) result.push(stage);
  }

  for (const stage of sortedStages(stages)) {
    if (!result.includes(stage)) result.push(stage);
  }

  return result.map((stage, index) => ({ ...stage, position: index }));
}

/** Appends a stage before the first closing stage, which reads naturally. */
export function addStage(
  stages: readonly PipelineStage[],
  stage: Omit<PipelineStage, 'position'>,
): readonly PipelineStage[] {
  const ordered = sortedStages(stages);
  const firstClosingIndex = ordered.findIndex((candidate) => candidate.outcome !== 'open');

  const insertAt =
    stage.outcome === 'open' && firstClosingIndex !== -1 ? firstClosingIndex : ordered.length;

  const next = [...ordered];
  next.splice(insertAt, 0, { ...stage, position: insertAt });

  return next.map((candidate, index) => ({ ...candidate, position: index }));
}

export const STAGE_DELETION_REFUSALS = {
  /** A pipeline with no stages could hold nothing. */
  LAST_STAGE: 'last_stage',
  /** Opportunities sit in it and no destination was given (F2.5). */
  NEEDS_DESTINATION: 'needs_destination',
  /** The destination is the stage being deleted, or is not in this pipeline. */
  INVALID_DESTINATION: 'invalid_destination',
} as const;

export type StageDeletionRefusal =
  (typeof STAGE_DELETION_REFUSALS)[keyof typeof STAGE_DELETION_REFUSALS];

export type StageDeletionDecision =
  | {
      readonly allowed: true;
      /** Where the stage's opportunities go. `null` when it is empty. */
      readonly moveToStageId: string | null;
    }
  | {
      readonly allowed: false;
      readonly reason: StageDeletionRefusal;
      /** How many opportunities are in the way, for the message (F2.5). */
      readonly occupiedBy: number;
    };

/**
 * Decides whether a stage may be deleted (F2.5): "deleting a stage that
 * contains opportunities is handled safely".
 *
 * Safely means refusing until the caller says where the opportunities should
 * go. Silently deleting them would destroy pipeline value; silently moving them
 * somewhere chosen for the user would misreport their pipeline. Both are worse
 * than an error that names the count.
 */
export function canDeleteStage(input: {
  readonly stages: readonly PipelineStage[];
  readonly stageId: string;
  readonly occupiedBy: number;
  readonly moveToStageId?: string | null | undefined;
}): StageDeletionDecision {
  const { stages, stageId, occupiedBy, moveToStageId } = input;

  if (stages.length <= 1) {
    return { allowed: false, reason: STAGE_DELETION_REFUSALS.LAST_STAGE, occupiedBy };
  }

  if (occupiedBy === 0) {
    return { allowed: true, moveToStageId: null };
  }

  if (moveToStageId === undefined || moveToStageId === null) {
    return { allowed: false, reason: STAGE_DELETION_REFUSALS.NEEDS_DESTINATION, occupiedBy };
  }

  if (moveToStageId === stageId || findStage(stages, moveToStageId) === undefined) {
    return { allowed: false, reason: STAGE_DELETION_REFUSALS.INVALID_DESTINATION, occupiedBy };
  }

  return { allowed: true, moveToStageId };
}
