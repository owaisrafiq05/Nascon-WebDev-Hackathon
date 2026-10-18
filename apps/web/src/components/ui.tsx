import type { ReactNode } from 'react';

/** Small layout pieces used across the feature pages. */

export function PageContainer({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wide ? 'max-w-6xl' : 'max-w-4xl'} px-4 py-8 sm:px-6`}>
      {children}
    </div>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold break-words text-slate-900 dark:text-slate-50">
        {children}
      </h1>
      {sub !== undefined && (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{sub}</p>
      )}
    </header>
  );
}

export function Card({
  title,
  id,
  children,
  actions,
}: {
  title?: string;
  id: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="mt-6 rounded-xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-700 dark:bg-slate-900"
    >
      {title !== undefined && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2
            id={`${id}-heading`}
            className="text-base font-semibold text-slate-900 dark:text-slate-50"
          >
            {title}
          </h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
      {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600 dark:border-slate-600 dark:text-slate-400">
      {children}
    </p>
  );
}

/** A status word with a symbol, so state is never colour alone (Q8). */
export function Badge({
  children,
  tone = 'neutral',
  symbol,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
  symbol?: string;
}) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
    good: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
    warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    bad: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {symbol !== undefined && <span aria-hidden="true">{symbol}</span>}
      {children}
    </span>
  );
}

export const ROW_CLASS =
  'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900';
export const MUTED = 'text-sm text-slate-600 dark:text-slate-400';
export const LINK_CLASS =
  'underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:focus-visible:ring-slate-100';
