import { useId, type SelectHTMLAttributes } from 'react';

/** A labelled native select (Q8). Native, so keyboard and screen readers just work. */
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly hideLabel?: boolean;
}

export const CONTROL_CLASS =
  'min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors duration-150 focus-visible:border-navy focus-visible:ring-2 focus-visible:ring-navy focus-visible:outline-none disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus-visible:border-brass-bright dark:focus-visible:ring-brass-bright';

export function Select({ label, hint, hideLabel = false, children, ...select }: SelectProps) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        htmlFor={id}
        className={hideLabel ? 'sr-only' : 'text-sm font-medium text-slate-800 dark:text-slate-200'}
      >
        {label}
      </label>
      <select {...select} id={id} className={`${CONTROL_CLASS} max-w-full`}>
        {children}
      </select>
      {hint !== undefined && <p className="text-xs text-slate-600 dark:text-slate-400">{hint}</p>}
    </div>
  );
}
