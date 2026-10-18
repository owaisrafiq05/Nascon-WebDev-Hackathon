import { PERMISSIONS } from '@ubmp/domain';
import { NavLink, Outlet } from 'react-router-dom';

import { Button } from '../components/Button.js';
import { useSession, useSignOut } from '../features/auth/session.js';

/**
 * The frame around every signed-in page: workspace name, navigation, sign out.
 *
 * Navigation only lists what the member may open. That is presentation, not
 * protection: the route guard and the server both refuse regardless (F1.5).
 */
export function AppShell() {
  const session = useSession();
  const signOut = useSignOut();

  const permissions = session.data?.membership.permissions ?? [];
  const canSeeAudit = permissions.includes(PERMISSIONS.AUDIT_LOG_VIEW);

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    `rounded-md px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:focus-visible:ring-slate-100 ${
      isActive
        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
    }`;

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      {/* Keyboard users can jump past the navigation (Q8). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <header className="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
              {session.data?.workspace.name ?? 'Workspace'}
            </p>
            <p className="truncate text-xs text-slate-600 dark:text-slate-400">
              {session.data?.user.email} · {session.data?.membership.baseLevel}
            </p>
          </div>

          <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
            <NavLink to="/" end className={linkClass}>
              Overview
            </NavLink>
            <NavLink to="/team" className={linkClass}>
              Team
            </NavLink>
            {canSeeAudit && (
              <NavLink to="/audit" className={linkClass}>
                Audit log
              </NavLink>
            )}
            <Button
              type="button"
              variant="secondary"
              busy={signOut.isPending}
              busyLabel="Signing out…"
              onClick={() => {
                signOut.mutate();
              }}
            >
              Sign out
            </Button>
          </nav>
        </div>
      </header>

      <main id="main">
        <Outlet />
      </main>
    </div>
  );
}
