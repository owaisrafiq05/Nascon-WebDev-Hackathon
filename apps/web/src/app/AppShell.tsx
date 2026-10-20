import { PERMISSIONS } from '@ubmp/domain';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { BrandMark } from '../components/BrandMark.js';
import { Button } from '../components/Button.js';
import { useSession, useSignOut } from '../features/auth/session.js';
import { LiveNotice } from '../features/realtime/LiveNotice.js';
import { useRealtime } from '../features/realtime/use-realtime.js';

/**
 * The frame around every signed-in page: workspace name, navigation, sign out.
 *
 * Navigation only lists what the member may open. That is presentation, not
 * protection: the route guard and the server both refuse regardless (F1.5).
 */
export function AppShell() {
  const session = useSession();
  const signOut = useSignOut();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // One socket for the whole signed-in app; events refetch whatever is open.
  const realtime = useRealtime();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const permissions = session.data?.membership.permissions ?? [];
  const canSeeAudit = permissions.includes(PERMISSIONS.AUDIT_LOG_VIEW);
  const canSeeCrm = permissions.includes(PERMISSIONS.CRM_VIEW);
  const canConfigure = permissions.includes(PERMISSIONS.ASSIGNMENT_RULES_MANAGE);
  const canManageMembers = permissions.includes(PERMISSIONS.MEMBERS_MANAGE);
  const canManageIntegrations = permissions.includes(PERMISSIONS.INTEGRATIONS_MANAGE);

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    `flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brass-bright focus-visible:outline-none ${
      isActive
        ? 'bg-navy-raise text-slate-50 shadow-[inset_3px_0_0_var(--color-brass-bright)]'
        : 'text-[#D5CBBA] hover:bg-navy-raise/70 hover:text-slate-50'
    }`;

  const nav = (
    <>
      <NavSection label="Work">
        <NavLink to="/" end className={linkClass}>
          Dashboard
        </NavLink>
        {canSeeCrm && (
          <>
            <NavLink to="/leads" end className={linkClass}>
              Leads
            </NavLink>
            <NavLink to="/conversations" className={linkClass}>
              Conversations
            </NavLink>
            <NavLink to="/payments" className={linkClass}>
              Payments
            </NavLink>
            <NavLink to="/appointments" className={linkClass}>
              Appointments
            </NavLink>
          </>
        )}
      </NavSection>

      {canSeeCrm && (
        <NavSection label="Records">
          <NavLink to="/contacts" className={linkClass}>
            Contacts
          </NavLink>
          <NavLink to="/pipeline" className={linkClass}>
            Pipeline
          </NavLink>
          <NavLink to="/lists" className={linkClass}>
            Lists
          </NavLink>
        </NavSection>
      )}

      <NavSection label="Workspace">
        {canManageMembers && (
          <NavLink to="/leads/manage" className={linkClass}>
            Leads admin
          </NavLink>
        )}
        {canManageIntegrations && (
          <NavLink to="/integrations" className={linkClass}>
            Integrations
          </NavLink>
        )}
        {canConfigure && (
          <NavLink to="/configuration" className={linkClass}>
            Configuration
          </NavLink>
        )}
        <NavLink to="/team" className={linkClass}>
          Team
        </NavLink>
        {canSeeAudit && (
          <NavLink to="/audit" className={linkClass}>
            Audit log
          </NavLink>
        )}
        <NavLink to="/settings" className={linkClass}>
          Settings
        </NavLink>
      </NavSection>
    </>
  );

  const identity = (
    <div className="min-w-0">
      <p className="truncate font-mono text-sm font-semibold text-slate-50">
        {session.data?.workspace.name ?? 'Workspace'}
      </p>
      <p className="truncate text-xs text-[#D5CBBA]">{session.data?.user.email}</p>
      {session.data !== undefined && session.data !== null && (
        <p className="mt-2 inline-flex rounded-sm bg-navy-raise px-2 py-0.5 font-mono text-xs tracking-wide text-brass-bright uppercase">
          {session.data.membership.baseLevel}
        </p>
      )}
    </div>
  );

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* Keyboard users can jump past the navigation (Q8). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-brass focus:px-3 focus:py-2 focus:text-brass-ink"
      >
        Skip to content
      </a>

      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh flex-col bg-navy lg:flex">
          <div className="flex items-center gap-3 border-b border-white/10 px-4 py-4">
            <BrandMark />
            <p className="font-mono text-sm font-semibold tracking-tight text-slate-50">UBMP</p>
          </div>
          <div className="border-b border-white/10 px-4 py-4">{identity}</div>
          <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
            {nav}
          </nav>
          <div className="border-t border-white/10 p-3">
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              busy={signOut.isPending}
              busyLabel="Signing out…"
              onClick={() => {
                signOut.mutate();
              }}
            >
              Sign out
            </Button>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-40 border-b border-white/10 bg-navy lg:hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <BrandMark className="h-8 w-8 shrink-0" />
                <p className="truncate font-mono text-sm font-semibold text-slate-50">
                  {session.data?.workspace.name ?? 'Workspace'}
                </p>
              </div>
              <button
                type="button"
                className="min-h-11 shrink-0 rounded-md px-3 text-sm font-medium text-slate-50 focus-visible:ring-2 focus-visible:ring-brass-bright focus-visible:outline-none"
                aria-expanded={menuOpen}
                aria-controls="app-nav"
                onClick={() => {
                  setMenuOpen((open) => !open);
                }}
              >
                {menuOpen ? 'Close menu' : 'Menu'}
              </button>
            </div>
            <nav
              id="app-nav"
              aria-label="Main"
              className={`px-3 pb-4 ${menuOpen ? 'block' : 'hidden'}`}
            >
              {nav}
              <div className="mt-4 border-t border-white/10 pt-3">
                <p className="px-3 text-xs text-[#D5CBBA]">{session.data?.user.email}</p>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    busy={signOut.isPending}
                    busyLabel="Signing out…"
                    onClick={() => {
                      signOut.mutate();
                    }}
                  >
                    Sign out
                  </Button>
                </div>
              </div>
            </nav>
          </header>

          <main id="main" className="desk-rise min-w-0">
            <Outlet />
          </main>
        </div>
      </div>

      <LiveNotice notice={realtime.notice} onDismiss={realtime.dismiss} />
    </div>
  );
}

function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="px-3 pb-1 font-mono text-xs font-medium tracking-[0.14em] text-[#B5A894] uppercase">
        {label}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
