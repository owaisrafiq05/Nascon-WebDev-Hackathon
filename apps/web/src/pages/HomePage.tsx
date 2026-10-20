import { Dashboard } from '../features/dashboard/Dashboard.js';
import { SystemStatusCard } from '../features/health/SystemStatusCard.js';

export function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <Dashboard />

      <details className="mt-10 rounded-lg border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
        <summary className="min-h-11 px-4 py-3 font-mono text-sm font-medium text-slate-800 focus-visible:ring-2 focus-visible:ring-navy focus-visible:outline-none dark:text-slate-100 dark:focus-visible:ring-brass-bright">
          System status
        </summary>
        <div className="border-t border-slate-200 px-4 py-4 sm:px-5 dark:border-slate-700">
          <SystemStatusCard />
        </div>
      </details>
    </div>
  );
}
