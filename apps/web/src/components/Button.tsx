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
    'bg-brass text-brass-ink hover:bg-[#c47b2b] focus-visible:ring-brass dark:focus-visible:ring-brass-bright',
  secondary:
    'border border-slate-300 bg-white text-slate-800 hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-navy dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 dark:focus-visible:ring-brass-bright',
  danger:
    'border border-red-300 bg-white text-red-800 hover:bg-red-50 focus-visible:ring-red-700 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950',
} as const;

export function Button({
  variant = 'primary',
  busy = false,
  busyLabel,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled === true || busy}
      aria-busy={busy}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-3.5 py-2 text-sm font-semibold transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 ${VARIANTS[variant]} ${className ?? ''}`}
    >
      {busy ? (busyLabel ?? 'Working…') : children}
    </button>
  );
}
