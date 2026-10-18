import { SystemStatusCard } from '../features/health/SystemStatusCard.js';

const PHASES = [
  { id: 'P0', label: 'Monorepo scaffold', done: true },
  { id: 'P1', label: 'Domain core: assignment, escalation, metrics', done: false },
  { id: 'P2', label: 'Accounts, workspaces, roles, audit', done: false },
  { id: 'P3', label: 'Customizable CRM', done: false },
  { id: 'P4', label: 'Lead capture, assignment, escalation, recovery', done: false },
  { id: 'P5', label: 'Real-time and operational dashboard', done: false },
  { id: 'P6', label: 'Integrations framework', done: false },
] as const;

export function HomePage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header>
        <p className="text-xs font-semibold tracking-widest text-slate-500 uppercase dark:text-slate-400">
          Scaffold
        </p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl dark:text-slate-50">
          Unified Business Management Platform
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          The workspace, CRM and lead-protection features are built in later phases. This page
          confirms the web app, the API and the database are wired together.
        </p>
      </header>

      <div className="mt-8">
        <SystemStatusCard />
      </div>

      <section aria-labelledby="phases-heading" className="mt-8">
        <h2
          id="phases-heading"
          className="text-base font-semibold text-slate-900 dark:text-slate-50"
        >
          Delivery phases
        </h2>
        <ul className="mt-3 space-y-2">
          {PHASES.map((phase) => (
            <li
              key={phase.id}
              className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
            >
              <span
                aria-hidden="true"
                className={
                  phase.done
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-400 dark:text-slate-500'
                }
              >
                {phase.done ? '✓' : '○'}
              </span>
              <span className="min-w-0 text-sm text-slate-800 dark:text-slate-200">
                <span className="font-mono font-semibold">{phase.id}</span>{' '}
                <span className="sr-only">{phase.done ? '(done)' : '(not started)'}</span>
                {phase.label}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
