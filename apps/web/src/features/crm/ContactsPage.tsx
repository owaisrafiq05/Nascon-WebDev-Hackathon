import { PERMISSIONS } from '@ubmp/domain';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { ApiError } from '../../lib/api.js';
import { useSession } from '../auth/session.js';
import { CustomFieldInputs } from './CustomFieldInputs.js';
import { useCompanies, useContacts, useCreateContact, useCustomFields } from './crm-api.js';

/**
 * The contacts list: search, filters and pagination (F2.1, F2.6, Q9).
 *
 * The quick filters here are the common ones. The full criteria builder lives
 * on the Lists page, because a saved list is a different thing from a glance at
 * the table.
 */
export function ContactsPage() {
  const session = useSession();
  const permissions = session.data?.membership.permissions ?? [];
  const canCreate = permissions.includes(PERMISSIONS.CRM_CREATE);

  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);

  const companies = useCompanies();
  const customFields = useCustomFields('contact');
  const contacts = useContacts({
    search,
    tag,
    companyId,
    page: String(page),
    limit: '25',
  });

  const create = useCreateContact();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [draftCustom, setDraftCustom] = useState<Record<string, unknown>>({});

  const serverFields = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};

  const companyNameById = new Map(
    (companies.data?.items ?? []).map((company) => [company.id, company.name]),
  );

  /** Any filter change returns to page 1, so the view is never past the end. */
  const setFilter = (apply: () => void): void => {
    apply();
    setPage(1);
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Contacts</h1>
        {canCreate && (
          <Button
            type="button"
            onClick={() => {
              setShowForm((current) => !current);
            }}
          >
            {showForm ? 'Close' : 'New contact'}
          </Button>
        )}
      </div>

      {showForm && canCreate && (
        <section
          aria-labelledby="new-contact-heading"
          className="mt-6 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
        >
          <h2
            id="new-contact-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-50"
          >
            New contact
          </h2>

          <form
            noValidate
            className="mt-4 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                {
                  ...draft,
                  ...(companyId === '' ? {} : { companyId }),
                  customFields: draftCustom,
                },
                {
                  onSuccess: () => {
                    setDraft({});
                    setDraftCustom({});
                    setShowForm(false);
                  },
                },
              );
            }}
          >
            <Alert error={create.error} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="First name"
                name="firstName"
                required
                value={typeof draft['firstName'] === 'string' ? draft['firstName'] : ''}
                error={serverFields['firstName']}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, firstName: event.target.value }));
                }}
              />
              <Field
                label="Last name"
                name="lastName"
                value={typeof draft['lastName'] === 'string' ? draft['lastName'] : ''}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, lastName: event.target.value }));
                }}
              />
              <Field
                label="Email"
                name="email"
                type="email"
                value={typeof draft['email'] === 'string' ? draft['email'] : ''}
                error={serverFields['email']}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    email: event.target.value === '' ? null : event.target.value,
                  }));
                }}
              />
              <Field
                label="Phone"
                name="phone"
                value={typeof draft['phone'] === 'string' ? draft['phone'] : ''}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    phone: event.target.value === '' ? null : event.target.value,
                  }));
                }}
              />
            </div>

            {/* Rendered from the workspace's definitions, so a field an Admin
                added appears here with no code change (F2.2). */}
            <CustomFieldInputs
              definitions={customFields.data?.customFields ?? []}
              values={draftCustom}
              errors={serverFields}
              onChange={(key, value) => {
                setDraftCustom((current) => ({ ...current, [key]: value }));
              }}
            />

            <Button type="submit" busy={create.isPending} busyLabel="Saving…">
              Save contact
            </Button>
          </form>
        </section>
      )}

      <section
        aria-labelledby="filters-heading"
        className="mt-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
      >
        <h2 id="filters-heading" className="sr-only">
          Search and filters
        </h2>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Search"
            name="search"
            type="search"
            hint="Name, email or phone"
            value={search}
            onChange={(event) => {
              setFilter(() => {
                setSearch(event.target.value);
              });
            }}
          />
          <Field
            label="Tag"
            name="tag"
            value={tag}
            onChange={(event) => {
              setFilter(() => {
                setTag(event.target.value);
              });
            }}
          />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="filter-company"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Company
            </label>
            <select
              id="filter-company"
              value={companyId}
              onChange={(event) => {
                setFilter(() => {
                  setCompanyId(event.target.value);
                });
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">Any company</option>
              {(companies.data?.items ?? []).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <div aria-live="polite" className="mt-6">
        {contacts.isPending && (
          <p className="text-sm text-slate-600 dark:text-slate-400">Loading contacts…</p>
        )}
        <Alert error={contacts.error} />
        {contacts.data !== undefined && contacts.data.items.length === 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            No contacts match those filters.
          </p>
        )}
      </div>

      {contacts.data !== undefined && contacts.data.items.length > 0 && (
        <>
          {/* Scrolls inside itself, so the page never scrolls sideways (Q7). */}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <caption className="sr-only">
                Contacts, page {contacts.data.pageInfo.page} of {contacts.data.pageInfo.totalPages}
              </caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Name
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Company
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Email
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Tags
                  </th>
                </tr>
              </thead>
              <tbody>
                {contacts.data.items.map((contact) => (
                  <tr key={contact.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2 pr-4">
                      <Link
                        to={`/contacts/${contact.id}`}
                        className="font-medium text-slate-900 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:text-slate-100"
                      >
                        {`${contact.firstName} ${contact.lastName}`.trim()}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">
                      {contact.companyId === null
                        ? '—'
                        : (companyNameById.get(contact.companyId) ?? '—')}
                    </td>
                    <td className="py-2 pr-4 break-all text-slate-700 dark:text-slate-300">
                      {contact.email ?? '—'}
                    </td>
                    <td className="py-2 text-slate-700 dark:text-slate-300">
                      {contact.tags.length === 0 ? '—' : contact.tags.join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav
            aria-label="Contact pages"
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Page {contacts.data.pageInfo.page} of {contacts.data.pageInfo.totalPages} ·{' '}
              {contacts.data.pageInfo.total} contacts
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => {
                  setPage((current) => current - 1);
                }}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={page >= contacts.data.pageInfo.totalPages}
                onClick={() => {
                  setPage((current) => current + 1);
                }}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
