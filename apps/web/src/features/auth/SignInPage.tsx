import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { useSignIn } from './session.js';

/**
 * Sign in (F1.1).
 *
 * Nothing here tries to be clever about *why* a sign-in failed: the server
 * returns one generic message for a wrong password, an unknown account and a
 * disabled one, and this page shows exactly that (Q1).
 */
export function SignInPage() {
  const navigate = useNavigate();
  const signIn = useSignIn();

  const [values, setValues] = useState({ email: '', password: '' });
  const [touched, setTouched] = useState(false);

  const missingEmail = values.email.trim() === '';
  const missingPassword = values.password === '';

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:py-16">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Sign in</h1>

      <form
        noValidate
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (missingEmail || missingPassword) return;

          signIn.mutate(values, {
            onSuccess: () => {
              void navigate('/', { replace: true });
            },
          });
        }}
      >
        {signIn.error !== null && <Alert error={signIn.error} />}

        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={values.email}
          onChange={(event) => {
            setValues((current) => ({ ...current, email: event.target.value }));
          }}
          error={touched && missingEmail ? 'Enter your email address.' : undefined}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={values.password}
          onChange={(event) => {
            setValues((current) => ({ ...current, password: event.target.value }));
          }}
          error={touched && missingPassword ? 'Enter your password.' : undefined}
        />

        <Button type="submit" busy={signIn.isPending} busyLabel="Signing in…">
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
        Need a workspace?{' '}
        <Link
          to="/sign-up"
          className="font-medium text-slate-900 underline focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:text-slate-100"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
