import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { ApiError } from '../../lib/api.js';
import { useCreateLead, type NewLeadInput } from './leads-api.js';

const EMPTY = { firstName: '', lastName: '', email: '', phone: '' };

/** Manual lead entry (F3.1). */
export function NewLeadForm() {
  const create = useCreateLead();
  const [values, setValues] = useState(EMPTY);
  const fieldErrors = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};

  const set =
    (key: keyof typeof EMPTY) =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      setValues((current) => ({ ...current, [key]: event.target.value }));
    };

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (values.firstName.trim() === '') return;
        const input: NewLeadInput = {
          firstName: values.firstName.trim(),
          ...(values.lastName.trim() === '' ? {} : { lastName: values.lastName.trim() }),
          ...(values.email.trim() === '' ? {} : { email: values.email.trim() }),
          ...(values.phone.trim() === '' ? {} : { phone: values.phone.trim() }),
        };
        create.mutate(input, {
          onSuccess: () => {
            setValues(EMPTY);
          },
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="First name"
          required
          value={values.firstName}
          onChange={set('firstName')}
          error={fieldErrors['firstName']}
        />
        <Field label="Last name" value={values.lastName} onChange={set('lastName')} />
        <Field
          label="Email"
          type="email"
          value={values.email}
          onChange={set('email')}
          error={fieldErrors['email']}
        />
        <Field label="Phone" type="tel" value={values.phone} onChange={set('phone')} />
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        <Alert error={create.error} />
        {create.isSuccess && (
          <Notice>
            {create.data.unassignedReason?.message ??
              (create.data.assigneeMembershipId === null ||
              create.data.assigneeMembershipId === undefined
                ? 'Lead created.'
                : 'Lead created and assigned.')}
          </Notice>
        )}
      </div>
      <div>
        <Button type="submit" busy={create.isPending} busyLabel="Creating…">
          Create lead
        </Button>
      </div>
    </form>
  );
}
