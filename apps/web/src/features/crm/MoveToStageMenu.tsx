import { useId } from 'react';

import type { Stage } from './crm-api.js';

/**
 * The keyboard route for moving an opportunity between stages (Q8).
 *
 * A native `<select>` rather than a custom menu: it is focusable, operable with
 * the arrow keys, announced correctly by a screen reader and usable on a touch
 * device, none of which a drag gesture offers. The board's drag and drop is the
 * pointer shortcut; this is the path that always works.
 */
export interface MoveToStageMenuProps {
  readonly stages: readonly Stage[];
  readonly currentStageId: string;
  readonly onMove: (stageId: string) => void;
  readonly busy?: boolean;
  /** Names the specific record, so every menu on the board is distinct. */
  readonly label: string;
}

export function MoveToStageMenu({
  stages,
  currentStageId,
  onMove,
  busy = false,
  label,
}: MoveToStageMenuProps) {
  const id = useId();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-slate-600 dark:text-slate-400">
        Move to
      </label>
      <select
        id={id}
        // The visible label reads "Move to" for everyone; the accessible name
        // names the record, because a board has one of these per card.
        aria-label={label}
        disabled={busy}
        value={currentStageId}
        onChange={(event) => {
          onMove(event.target.value);
        }}
        className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
      >
        {stages.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.name}
          </option>
        ))}
      </select>
    </div>
  );
}
