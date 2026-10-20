import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { KICKER_CLASS } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { AUTH_LINK, AuthFrame } from './AuthFrame.js';
import { useSignUp } from './session.js';

/**
 * Sign up: creates the workspace and makes this person its Owner (F1.1).
 *
 * Validation happens twice on purpose. The checks here are for immediate
 * feedback; the server validates again and is the authority, and its
 * field-level errors are merged into the same display so the user sees one set
 * of messages wherever they came from (F1.5, Q10).
 */
const MIN_PASSWORD_LENGTH = 12;

interface Errors {
  name?: string;
  email?: string;
  password?: string;
  workspaceName?: string;
}

function validate(values: {
  name: string;
  email: string;
  password: string;
  workspaceName: string;
}): Errors {
  const errors: Errors = {};

  if (values.name.trim() === '') errors.name = 'Enter your name.';
  if (values.workspaceName.trim() === '') errors.workspaceName = 'Enter a name for your company.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  if (values.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }

  return errors;
}

export function SignUpPage() {
  const navigate = useNavigate();
  const signUp = useSignUp();

  const [values, setValues] = useState({
    name: '',
    email: '',
    password: '',
    workspaceName: '',
  });
  const [touched, setTouched] = useState(false);

  const localErrors = validate(values);
  // Field errors the server reported, which the browser could not know about
  // (an address already registered, for example).
  const serverErrors = signUp.error instanceof ApiError ? (signUp.error.fields ?? {}) : {};
  const errors: Errors = touched ? { ...localErrors, ...serverErrors } : serverErrors;

  const set = (field: keyof typeof values) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
  };

  return (
    <AuthFrame
      kicker="New workspace"
      headline="Open a company desk."
      lede="You become the Owner. Invite the team once the workspace exists."
    >
      <p className={KICKER_CLASS}>Account</p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">
        Create a workspace
      </h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        You will be its Owner, and can invite your team afterwards.
      </p>

      <form
        noValidate
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (Object.keys(validate(values)).length > 0) return;

          signUp.mutate(values, {
            onSuccess: () => {
              void navigate('/', { replace: true });
            },
          });
        }}
      >
        {/* Field-level messages appear by their inputs; this is for the rest. */}
        {signUp.error !== null && Object.keys(serverErrors).length === 0 && (
          <Alert error={signUp.error} />
        )}

        <Field
          label="Your name"
          name="name"
          autoComplete="name"
          required
          value={values.name}
          onChange={set('name')}
          error={errors.name}
        />
        <Field
          label="Company name"
          name="workspaceName"
          autoComplete="organization"
          required
          value={values.workspaceName}
          onChange={set('workspaceName')}
          error={errors.workspaceName}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={values.email}
          onChange={set('email')}
          error={errors.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={values.password}
          onChange={set('password')}
          error={errors.password}
          hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters.`}
        />

        <Button type="submit" busy={signUp.isPending} busyLabel="Creating your workspace…">
          Create workspace
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
        Already have an account?{' '}
        <Link to="/sign-in" className={AUTH_LINK}>
          Sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
