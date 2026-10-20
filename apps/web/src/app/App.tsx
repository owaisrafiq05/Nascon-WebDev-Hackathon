import { PERMISSIONS, type Permission } from '@ubmp/domain';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AcceptInvitePage } from '../features/auth/AcceptInvitePage.js';
import { SignInPage } from '../features/auth/SignInPage.js';
import { SignUpPage } from '../features/auth/SignUpPage.js';
import { useSession } from '../features/auth/session.js';
import { AUDIT_PERMISSION, AuditPage } from '../features/audit/AuditPage.js';
import { AppointmentsPage } from '../features/calendar/AppointmentsPage.js';
import { ContactDetailPage } from '../features/crm/ContactDetailPage.js';
import { ContactsPage } from '../features/crm/ContactsPage.js';
import { CrmAdminPage } from '../features/crm/CrmAdminPage.js';
import { ListsPage } from '../features/crm/ListsPage.js';
import { OpportunityDetailPage } from '../features/crm/OpportunityDetailPage.js';
import { PipelinePage } from '../features/crm/PipelinePage.js';
import { IntegrationsPage } from '../features/integrations/IntegrationsPage.js';
import { LeadsManagePage } from '../features/leads/LeadsManagePage.js';
import { LeadsPage } from '../features/leads/LeadsPage.js';
import { RecoveryPage } from '../features/leads/RecoveryPage.js';
import { ConversationThreadPage } from '../features/messaging/ConversationThreadPage.js';
import { ConversationsPage } from '../features/messaging/ConversationsPage.js';
import { PaymentsPage } from '../features/payments/PaymentsPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
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
      <p className="p-6 font-mono text-sm text-slate-600 dark:text-slate-400" role="status">
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

          {/* The CRM. Each page needs crm.record.view; the server enforces it
              too, so these guards are presentation only (F1.5). */}
          <Route
            path="/contacts"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <ContactsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/contacts/:contactId"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <ContactDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/pipeline"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <PipelinePage />
              </RequirePermission>
            }
          />
          <Route
            path="/opportunities/:opportunityId"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <OpportunityDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/lists"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <ListsPage />
              </RequirePermission>
            }
          />
          {/* Configuration is rendered for anyone signed in and explains itself
              to a member who lacks the permission, rather than redirecting away
              from a page they were told to open. */}
          <Route path="/configuration" element={<CrmAdminPage />} />

          {/* Leads, messaging, payments and appointments (P4 - P9). The server
              checks every endpoint; these guards only decide what renders. */}
          <Route
            path="/leads"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <LeadsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/leads/manage"
            element={
              <RequirePermission permission={PERMISSIONS.MEMBERS_MANAGE}>
                <LeadsManagePage />
              </RequirePermission>
            }
          />
          <Route
            path="/recovery"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <RecoveryPage />
              </RequirePermission>
            }
          />
          <Route
            path="/conversations"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <ConversationsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/conversations/:conversationId"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <ConversationThreadPage />
              </RequirePermission>
            }
          />
          <Route
            path="/payments"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <PaymentsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/appointments"
            element={
              <RequirePermission permission={PERMISSIONS.CRM_VIEW}>
                <AppointmentsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/integrations"
            element={
              <RequirePermission permission={PERMISSIONS.INTEGRATIONS_MANAGE}>
                <IntegrationsPage />
              </RequirePermission>
            }
          />
          <Route path="/settings" element={<SettingsPage />} />

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
