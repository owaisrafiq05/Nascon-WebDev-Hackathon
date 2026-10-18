import type { ButtonHTMLAttributes } from 'react';

/**
 * A button with a visible focus ring and a busy state.
 *
 * While busy it stays in the accessibility tree as disabled with `aria-busy`,
 * and its label changes, so the loading state is announced rather than only
 * shown as a spinner (Q10).
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'danger';
  readonly busy?: boolean;
  readonly busyLabel?: string;
}

const VARIANTS = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-800 focus-visible:ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white dark:focus-visible:ring-slate-100',
  secondary:
    'border border-slate-300 text-slate-800 hover:bg-slate-50 focus-visible:ring-slate-900 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800 dark:focus-visible:ring-slate-100',
  danger:
    'border border-red-300 text-red-800 hover:bg-red-50 focus-visible:ring-red-700 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950',
} as const;

export function Button({
  variant = 'primary',
  busy = false,
  busyLabel,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled === true || busy}
      aria-busy={busy}
      className={`rounded-md px-3.5 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 ${VARIANTS[variant]}`}
    >
      {busy ? (busyLabel ?? 'Working…') : children}
    </button>
  );
}
