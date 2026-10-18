import { describe, expect, it } from 'vitest';

import {
  addStage,
  canDeleteStage,
  DEFAULT_STAGES,
  findStage,
  type PipelineStage,
  reorderStages,
  sortedStages,
  STAGE_DELETION_REFUSALS,
} from './pipeline.js';

const stages: readonly PipelineStage[] = [
  { id: 'new', name: 'New', position: 0, outcome: 'open' },
  { id: 'qualifying', name: 'Qualifying', position: 1, outcome: 'open' },
  { id: 'won', name: 'Won', position: 2, outcome: 'won' },
];

describe('DEFAULT_STAGES', () => {
  it('ends with a won and a lost stage, so the pipeline can be closed', () => {
    const outcomes = DEFAULT_STAGES.map((stage) => stage.outcome);

    expect(outcomes).toContain('won');
    expect(outcomes).toContain('lost');
  });

  it('is numbered contiguously from 0', () => {
    expect(DEFAULT_STAGES.map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('sortedStages', () => {
  it('orders by position, not by array order', () => {
    const scrambled = [stages[2]!, stages[0]!, stages[1]!];

    expect(sortedStages(scrambled).map((stage) => stage.id)).toEqual(['new', 'qualifying', 'won']);
  });
});

describe('findStage', () => {
  it('finds by id and returns undefined for an unknown one', () => {
    expect(findStage(stages, 'qualifying')?.name).toBe('Qualifying');
    expect(findStage(stages, 'nope')).toBeUndefined();
  });
});

describe('reorderStages', () => {
  it('applies the given order and renumbers from 0', () => {
    const reordered = reorderStages(stages, ['qualifying', 'new', 'won']);

    expect(reordered.map((stage) => stage.id)).toEqual(['qualifying', 'new', 'won']);
    expect(reordered.map((stage) => stage.position)).toEqual([0, 1, 2]);
  });

  it('keeps a stage that the caller left out, rather than dropping it', () => {
    // A reorder computed against a slightly stale list must not lose a stage.
    const reordered = reorderStages(stages, ['won']);

    expect(reordered.map((stage) => stage.id)).toEqual(['won', 'new', 'qualifying']);
    expect(reordered).toHaveLength(3);
  });

  it('ignores an unknown id', () => {
    const reordered = reorderStages(stages, ['ghost', 'won']);

    expect(reordered.map((stage) => stage.id)).toEqual(['won', 'new', 'qualifying']);
  });

  it('never produces a gap or a tie, however often it runs', () => {
    let current = stages;
    for (const order of [['won', 'new'], ['qualifying'], ['new', 'won', 'qualifying']]) {
      current = reorderStages(current, order);
      expect(current.map((stage) => stage.position)).toEqual([0, 1, 2]);
    }
  });

  it('does not rename or re-outcome anything', () => {
    const reordered = reorderStages(stages, ['won', 'new', 'qualifying']);

    expect(reordered.find((stage) => stage.id === 'won')?.outcome).toBe('won');
    expect(reordered.find((stage) => stage.id === 'new')?.name).toBe('New');
  });
});

describe('addStage', () => {
  it('inserts an open stage before the first closing stage', () => {
    const next = addStage(stages, { id: 'proposal', name: 'Proposal', outcome: 'open' });

    expect(next.map((stage) => stage.id)).toEqual(['new', 'qualifying', 'proposal', 'won']);
    expect(next.map((stage) => stage.position)).toEqual([0, 1, 2, 3]);
  });

  it('appends a closing stage at the end', () => {
    const next = addStage(stages, { id: 'lost', name: 'Lost', outcome: 'lost' });

    expect(next.map((stage) => stage.id)).toEqual(['new', 'qualifying', 'won', 'lost']);
  });

  it('appends to a pipeline with no closing stage', () => {
    const openOnly = [stages[0]!, stages[1]!];
    const next = addStage(openOnly, { id: 'proposal', name: 'Proposal', outcome: 'open' });

    expect(next.map((stage) => stage.id)).toEqual(['new', 'qualifying', 'proposal']);
  });
});

describe('canDeleteStage (F2.5)', () => {
  it('allows deleting an empty stage', () => {
    expect(canDeleteStage({ stages, stageId: 'qualifying', occupiedBy: 0 })).toEqual({
      allowed: true,
      moveToStageId: null,
    });
  });

  it('refuses a populated stage with no destination, reporting the count', () => {
    const decision = canDeleteStage({ stages, stageId: 'qualifying', occupiedBy: 4 });

    expect(decision).toEqual({
      allowed: false,
      reason: STAGE_DELETION_REFUSALS.NEEDS_DESTINATION,
      occupiedBy: 4,
    });
  });

  it('allows a populated stage once a destination is given', () => {
    const decision = canDeleteStage({
      stages,
      stageId: 'qualifying',
      occupiedBy: 4,
      moveToStageId: 'new',
    });

    expect(decision).toEqual({ allowed: true, moveToStageId: 'new' });
  });

  it('refuses moving the opportunities into the stage being deleted', () => {
    const decision = canDeleteStage({
      stages,
      stageId: 'qualifying',
      occupiedBy: 4,
      moveToStageId: 'qualifying',
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: STAGE_DELETION_REFUSALS.INVALID_DESTINATION,
    });
  });

  it('refuses a destination that is not in this pipeline', () => {
    const decision = canDeleteStage({
      stages,
      stageId: 'qualifying',
      occupiedBy: 4,
      moveToStageId: 'someone-elses-stage',
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: STAGE_DELETION_REFUSALS.INVALID_DESTINATION,
    });
  });

  it('refuses deleting the only stage, since a pipeline needs one', () => {
    const decision = canDeleteStage({
      stages: [stages[0]!],
      stageId: 'new',
      occupiedBy: 0,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: STAGE_DELETION_REFUSALS.LAST_STAGE,
    });
  });

  it('ignores a destination for an empty stage, since nothing moves', () => {
    expect(
      canDeleteStage({ stages, stageId: 'qualifying', occupiedBy: 0, moveToStageId: 'new' }),
    ).toEqual({ allowed: true, moveToStageId: null });
  });
});
