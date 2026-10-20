import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { KICKER_CLASS } from '../../components/ui.js';
import { apiRequest } from '../../lib/api.js';
import { AUTH_LINK, AuthFrame } from './AuthFrame.js';

/**
 * Accepting an invitation: the invitee sets their password once (F1.2).
 *
 * Unauthenticated by design, because the invitee has no session yet; the token
 * in the link is what authorises them. On success they are sent to sign in, so
 * there is one path for establishing a session.
 */
const MIN_PASSWORD_LENGTH = 12;

export function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

  const accept = useMutation({
    mutationFn: (values: { token: string; name: string; password: string }) =>
      apiRequest('/api/members/invites/accept', z.unknown(), { method: 'POST', body: values }),
  });

  const passwordError =
    touched && password.length < MIN_PASSWORD_LENGTH
      ? `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`
      : undefined;

  if (token === '') {
    return (
      <AuthFrame
        kicker="Invitation"
        headline="This link is incomplete."
        lede="Ask whoever invited you to send a fresh link."
      >
        <p className={KICKER_CLASS}>Account</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">
          That link is incomplete
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          The invitation link is missing its token. Ask whoever invited you to send it again.
        </p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      kicker="Invitation"
      headline="Take your seat."
      lede="Set a password, then sign in with the email address on the invite."
    >
      <p className={KICKER_CLASS}>Account</p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">
        Finish setting up your account
      </h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Choose a password. You will use your invited email address to sign in.
      </p>

      <form
        noValidate
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (password.length < MIN_PASSWORD_LENGTH) return;

          accept.mutate(
            { token, name: name.trim() === '' ? 'New member' : name.trim(), password },
            {
              onSuccess: () => {
                void navigate('/sign-in', { replace: true });
              },
            },
          );
        }}
      >
        <Alert error={accept.error} />

        <Field
          label="Your name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          error={passwordError}
          hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters.`}
        />

        <Button type="submit" busy={accept.isPending} busyLabel="Setting up…">
          Set password and continue
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
        Already set up?{' '}
        <Link to="/sign-in" className={AUTH_LINK}>
          Sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
