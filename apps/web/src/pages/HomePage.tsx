import { Dashboard } from '../features/dashboard/Dashboard.js';
import { SystemStatusCard } from '../features/health/SystemStatusCard.js';

export function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Dashboard />

      <details className="mt-10">
        <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
          System status
        </summary>
        <div className="mt-3 max-w-xl">
          <SystemStatusCard />
        </div>
      </details>
    </div>
  );
}
