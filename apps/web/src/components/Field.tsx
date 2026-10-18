import { useId, type InputHTMLAttributes } from 'react';

/**
 * A labelled text input (Q8).
 *
 * The label is always a real `<label>` tied to the input by id, never a
 * placeholder: a placeholder disappears as soon as someone types, and screen
 * readers do not reliably announce it.
 *
 * An error is linked with `aria-describedby` and marked with `aria-invalid`, so
 * the message is announced rather than only turning the border red (Q8, Q10).
 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
}

export function Field({ label, error, hint, ...input }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const describedBy = [error === undefined ? null : errorId, hint === undefined ? null : hintId]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">
        {label}
        {input.required === true && (
          <span aria-hidden="true" className="ml-1 text-red-700 dark:text-red-400">
            *
          </span>
        )}
      </label>

      <input
        {...input}
        id={id}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:border-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none disabled:opacity-60 aria-invalid:border-red-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus-visible:border-slate-100 dark:focus-visible:ring-slate-100"
      />

      {hint !== undefined && (
        <p id={hintId} className="text-xs text-slate-600 dark:text-slate-400">
          {hint}
        </p>
      )}

      {error !== undefined && (
        <p id={errorId} className="text-xs font-medium text-red-700 dark:text-red-400">
          {/* A symbol as well as colour, so the state is not colour-only. */}
          <span aria-hidden="true">! </span>
          {error}
        </p>
      )}
    </div>
  );
}
