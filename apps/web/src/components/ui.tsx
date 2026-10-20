import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Small layout pieces used across the feature pages. */

export function PageContainer({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wide ? 'max-w-6xl' : 'max-w-4xl'} px-4 py-8 sm:px-6 lg:px-8`}>
      {children}
    </div>
  );
}

export const KICKER_CLASS =
  'font-mono text-xs font-medium tracking-[0.16em] text-[#9A3412] uppercase dark:text-brass-bright';

export const BACK_LINK =
  'font-medium text-navy underline decoration-brass-bright decoration-2 underline-offset-4 focus-visible:ring-2 focus-visible:ring-navy focus-visible:outline-none dark:text-brass-bright dark:focus-visible:ring-brass-bright';

/** Shared surface for sections that are not the `Card` component. */
export const SURFACE =
  'rounded-lg border border-slate-300 bg-white shadow-[0_1px_0_rgba(26,22,18,0.04)] dark:border-slate-700 dark:bg-slate-900 dark:shadow-none';

export function PageTitle({
  children,
  sub,
  kicker,
  actions,
}: {
  children: ReactNode;
  sub?: string | undefined;
  kicker?: string | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-5 dark:border-slate-800">
      <div className="min-w-0">
        {kicker !== undefined && <p className={KICKER_CLASS}>{kicker}</p>}
        <h1 className="mt-1 text-2xl font-semibold break-words text-slate-900 sm:text-3xl dark:text-slate-50">
          {children}
        </h1>
        {sub !== undefined && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {sub}
          </p>
        )}
      </div>
      {actions}
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
      className="mt-6 rounded-lg border border-slate-300 bg-white p-4 shadow-[0_1px_0_rgba(26,22,18,0.04)] sm:p-5 dark:border-slate-700 dark:bg-slate-900 dark:shadow-none"
    >
      {title !== undefined && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2
            id={`${id}-heading`}
            className="font-mono text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-50"
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
    <p role="status" className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-8 animate-pulse rounded-full bg-brass"
      />
      {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-400">
      {children}
    </p>
  );
}

/** A status word with a symbol, so state is never colour alone (Q8). */
export function Badge({
  children,
  tone = 'neutral',
  icon: Icon,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
  /** An icon beside the word, so state is never colour alone (Q8). */
  icon?: LucideIcon | undefined;
}) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
    good: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
    warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    bad: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 font-mono text-xs font-medium tracking-wide ${tones[tone]}`}
    >
      {Icon !== undefined && <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />}
      {children}
    </span>
  );
}

export const ROW_CLASS =
  'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-4 py-3 shadow-[0_1px_0_rgba(26,22,18,0.04)] transition-colors duration-150 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:shadow-none dark:hover:border-slate-500 dark:hover:bg-slate-800';
export const MUTED = 'text-sm text-slate-600 dark:text-slate-400';
export const LINK_CLASS =
  'underline decoration-brass-bright decoration-2 underline-offset-4 focus-visible:ring-2 focus-visible:ring-navy focus-visible:outline-none dark:focus-visible:ring-brass-bright';
