import type { Permission } from '@ubmp/domain';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AcceptInvitePage } from '../features/auth/AcceptInvitePage.js';
import { SignInPage } from '../features/auth/SignInPage.js';
import { SignUpPage } from '../features/auth/SignUpPage.js';
import { useSession } from '../features/auth/session.js';
import { AUDIT_PERMISSION, AuditPage } from '../features/audit/AuditPage.js';
import { TeamPage } from '../features/team/TeamPage.js';
import { HomePage } from '../pages/HomePage.js';
import { AppShell } from './AppShell.js';

/**
 * The route table.
 *
 * Guards here decide what to *render*; they are not security. Every endpoint
 * behind these pages checks the session and the permission on the server, which
 * is what F1.5 requires and what the API tests assert.
 */
function RequireSession({ children }: { children: ReactElement }) {
  const session = useSession();
  const location = useLocation();

  // Still deciding. Rendering the sign-in page here would bounce a signed-in
  // member out on every reload.
  if (session.isPending) {
    return (
      <p className="p-6 text-sm text-slate-600 dark:text-slate-400" role="status">
        Checking your session…
      </p>
    );
  }

  if (session.data === null || session.data === undefined) {
    // `state` remembers where they were going, so signing in returns them.
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return children;
}

/** Hides a page the member has no permission for, rather than 403-ing in the UI. */
function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactElement;
}) {
  const session = useSession();

  if (session.isPending) return null;
  if (!(session.data?.membership.permissions.includes(permission) ?? false)) {
    return <Navigate to="/" replace />;
  }

  return children;
}

/** Sends an already signed-in member away from the sign-in and sign-up pages. */
function RedirectIfSignedIn({ children }: { children: ReactElement }) {
  const session = useSession();

  if (session.isPending) return null;
  if (session.data !== null && session.data !== undefined) return <Navigate to="/" replace />;

  return children;
}

export function App() {
  return (
    <div className="min-h-dvh text-slate-900 dark:text-slate-100">
      <Routes>
        <Route
          path="/sign-up"
          element={
            <RedirectIfSignedIn>
              <SignUpPage />
            </RedirectIfSignedIn>
          }
        />
        <Route
          path="/sign-in"
          element={
            <RedirectIfSignedIn>
              <SignInPage />
            </RedirectIfSignedIn>
          }
        />
        {/* Reachable without a session: the invitee has none yet. */}
        <Route path="/accept-invite" element={<AcceptInvitePage />} />

        <Route
          element={
            <RequireSession>
              <AppShell />
            </RequireSession>
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route
            path="/audit"
            element={
              <RequirePermission permission={AUDIT_PERMISSION}>
                <AuditPage />
              </RequirePermission>
            }
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
