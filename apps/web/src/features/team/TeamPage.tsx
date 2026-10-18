import { BASE_LEVELS, PERMISSIONS, type BaseLevel } from '@ubmp/domain';
import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { useSession } from '../auth/session.js';
import { PermissionMatrix } from './PermissionMatrix.js';
import {
  useChangeBaseLevel,
  useInviteMember,
  useMembers,
  usePermissionSets,
  useRemoveMember,
} from './team-api.js';

/**
 * The Team page (F1.2, F1.3): who is in the workspace, who has been invited,
 * and the controls to change either.
 *
 * Controls are hidden from anyone who cannot use them, but that is presentation
 * only: the server refuses the same calls regardless (F1.5), which the API
 * tests assert directly.
 */
const LEVEL_LABEL: Record<BaseLevel, string> = {
  owner: 'Owner',
  admin: 'Admin',
  user: 'User',
};

export function TeamPage() {
  const session = useSession();
  const members = useMembers();

  const canManage =
    session.data?.membership.permissions.includes(PERMISSIONS.MEMBERS_MANAGE) ?? false;
  const isOwner = session.data?.membership.baseLevel === 'owner';
  const permissionSets = usePermissionSets(canManage);

  const invite = useInviteMember();
  const changeLevel = useChangeBaseLevel();
  const removeMember = useRemoveMember();

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLevel, setInviteLevel] = useState<BaseLevel>('user');
  const [editingPermissionsFor, setEditingPermissionsFor] = useState<string | null>(null);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Team</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        {session.data?.workspace.name}
      </p>

      {canManage && (
        <section
          aria-labelledby="invite-heading"
          className="mt-8 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
        >
          <h2
            id="invite-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-50"
          >
            Invite someone
          </h2>

          <form
            noValidate
            className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              invite.mutate(
                { email: inviteEmail.trim(), baseLevel: inviteLevel },
                {
                  onSuccess: () => {
                    setInviteEmail('');
                  },
                },
              );
            }}
          >
            <div className="flex-1">
              <Field
                label="Email"
                name="inviteEmail"
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => {
                  setInviteEmail(event.target.value);
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="invite-level"
                className="text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Level
              </label>
              <select
                id="invite-level"
                value={inviteLevel}
                onChange={(event) => {
                  setInviteLevel(event.target.value as BaseLevel);
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              >
                {BASE_LEVELS.filter((level) => level !== 'owner' || isOwner).map((level) => (
                  <option key={level} value={level}>
                    {LEVEL_LABEL[level]}
                  </option>
                ))}
              </select>
            </div>

            <Button type="submit" busy={invite.isPending} busyLabel="Inviting…">
              Send invitation
            </Button>
          </form>

          <div className="mt-4">
            <Alert error={invite.error} />
            {invite.isSuccess && (
              <Notice>
                <p className="font-medium">Invitation created for {invite.data.email}.</p>
                {/* Until P10 delivers invitations over the notification
                    provider, the inviter passes this link on themselves. */}
                <p className="mt-1 break-all">
                  Send them this link:{' '}
                  <code className="font-mono text-xs">
                    {window.location.origin}/accept-invite?token={invite.data.token}
                  </code>
                </p>
              </Notice>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="members-heading" className="mt-8">
        <h2
          id="members-heading"
          className="text-base font-semibold text-slate-900 dark:text-slate-50"
        >
          Members
        </h2>

        <div aria-live="polite" className="mt-3">
          {members.isPending && (
            <p className="text-sm text-slate-600 dark:text-slate-400">Loading the team…</p>
          )}
          <Alert error={members.error} />
          <Alert error={changeLevel.error} />
          <Alert error={removeMember.error} />
        </div>

        {members.data !== undefined && (
          <ul className="mt-2 flex flex-col gap-3">
            {members.data.members.map((member) => (
              <li
                key={member.membershipId}
                className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium break-all text-slate-900 dark:text-slate-100">
                      {member.email}
                    </p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {LEVEL_LABEL[member.baseLevel]} · {member.permissions.length} permissions
                    </p>
                  </div>

                  {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor={`level-${member.membershipId}`}
                        className="text-xs text-slate-600 dark:text-slate-400"
                      >
                        Level
                      </label>
                      <select
                        id={`level-${member.membershipId}`}
                        /* A unique accessible name: there is one of these per
                           member, and "Level" alone would announce the same for
                           all of them (Q8). */
                        aria-label={`Level for ${member.email}`}
                        value={member.baseLevel}
                        disabled={changeLevel.isPending}
                        onChange={(event) => {
                          changeLevel.mutate({
                            membershipId: member.membershipId,
                            baseLevel: event.target.value as BaseLevel,
                          });
                        }}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                      >
                        {BASE_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {LEVEL_LABEL[level]}
                          </option>
                        ))}
                      </select>

                      {isOwner && (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            setEditingPermissionsFor((current) =>
                              current === member.membershipId ? null : member.membershipId,
                            );
                          }}
                        >
                          {editingPermissionsFor === member.membershipId
                            ? 'Close permissions'
                            : 'Permissions'}
                        </Button>
                      )}

                      {member.baseLevel !== 'owner' && (
                        <Button
                          type="button"
                          variant="danger"
                          busy={removeMember.isPending}
                          onClick={() => {
                            removeMember.mutate(member.membershipId);
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {editingPermissionsFor === member.membershipId &&
                  permissionSets.data !== undefined && (
                    <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-700">
                      <PermissionMatrix
                        member={member}
                        sets={permissionSets.data}
                        onDone={() => {
                          setEditingPermissionsFor(null);
                        }}
                      />
                    </div>
                  )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {members.data !== undefined && members.data.pendingInvites.length > 0 && (
        <section aria-labelledby="invites-heading" className="mt-8">
          <h2
            id="invites-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-50"
          >
            Pending invitations
          </h2>

          <ul className="mt-3 flex flex-col gap-2">
            {members.data.pendingInvites.map((pending) => (
              <li
                key={pending.inviteId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <span className="break-all text-slate-900 dark:text-slate-100">
                  {pending.email}
                </span>
                <span className="text-slate-600 dark:text-slate-400">
                  {LEVEL_LABEL[pending.baseLevel]} ·{' '}
                  {pending.expired
                    ? 'expired'
                    : `expires ${new Date(pending.expiresAt).toLocaleDateString()}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
