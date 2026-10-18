import {
  FILTER_FIELDS,
  FILTER_OPERATORS,
  operatorTakesValue,
  type Filter,
  type FilterCriterion,
  type FilterField,
  type FilterOperator,
} from '@ubmp/domain';
import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import {
  useCreateSavedList,
  useDeleteSavedList,
  useRunFilter,
  useSavedListResults,
  useSavedLists,
} from './crm-api.js';

/**
 * The saved list builder (F2.6).
 *
 * Criteria are assembled, previewed against live data, then saved. A saved list
 * stores the filter rather than the matching records, so reopening it re-runs
 * the query — a record edited afterwards joins or leaves the list without
 * anything being refreshed.
 *
 * The field and operator choices come from the domain's own vocabulary, which
 * is the same list the server validates against, so the builder cannot offer a
 * combination that would be refused.
 */
const FIELD_LABELS: Partial<Record<FilterField, string>> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  tag: 'Tag',
  company: 'Company',
  owner: 'Owner',
  stage: 'Stage',
  stageOutcome: 'Stage outcome',
  value: 'Value',
  createdAt: 'Created',
  lastActivityAt: 'Last activity',
  customField: 'Custom field',
};

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  in: 'is one of',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  isSet: 'has a value',
  isNotSet: 'has no value',
};

interface DraftCriterion {
  field: FilterField;
  key: string;
  operator: FilterOperator;
  value: string;
  valueTo: string;
}

const EMPTY_CRITERION: DraftCriterion = {
  field: 'tag',
  key: '',
  operator: 'eq',
  value: '',
  valueTo: '',
};

/** Turns the form's strings into the DSL the server expects. */
function toCriterion(draft: DraftCriterion): FilterCriterion {
  const base = {
    field: draft.field,
    ...(draft.field === 'customField' ? { key: draft.key.trim() } : {}),
    operator: draft.operator,
  };

  if (!operatorTakesValue(draft.operator)) return base;

  if (draft.operator === 'between') {
    return { ...base, value: [coerce(draft.value), coerce(draft.valueTo)] };
  }

  if (draft.operator === 'in') {
    return {
      ...base,
      value: draft.value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    };
  }

  return { ...base, value: coerce(draft.value) };
}

/**
 * A one-line label for a result row, whatever entity it came from.
 *
 * Only string fields are read: a result is an open record, and anything else
 * would stringify to "[object Object]".
 */
function describeRecord(item: Record<string, unknown>): string {
  const firstName = typeof item['firstName'] === 'string' ? item['firstName'] : '';
  const lastName = typeof item['lastName'] === 'string' ? item['lastName'] : '';
  const full = `${firstName} ${lastName}`.trim();
  if (full !== '') return full;

  if (typeof item['name'] === 'string') return item['name'];
  return typeof item['id'] === 'string' ? item['id'] : 'Untitled record';
}

/** A numeric-looking value is sent as a number, so numeric comparisons work. */
function coerce(raw: string): string | number {
  const trimmed = raw.trim();
  if (trimmed === '') return trimmed;

  const asNumber = Number(trimmed);
  return Number.isNaN(asNumber) || trimmed !== String(asNumber) ? trimmed : asNumber;
}

export function ListsPage() {
  const savedLists = useSavedLists();
  const createList = useCreateSavedList();
  const deleteList = useDeleteSavedList();
  const runFilter = useRunFilter();

  const [entity, setEntity] = useState<'contact' | 'company' | 'opportunity'>('contact');
  const [join, setJoin] = useState<'and' | 'or'>('and');
  const [criteria, setCriteria] = useState<DraftCriterion[]>([EMPTY_CRITERION]);
  const [name, setName] = useState('');
  const [openListId, setOpenListId] = useState<string | null>(null);

  const openList = useSavedListResults(openListId);

  const filter: Filter = { join, criteria: criteria.map(toCriterion) };

  const update = (index: number, patch: Partial<DraftCriterion>): void => {
    setCriteria((current) =>
      current.map((criterion, position) =>
        position === index ? { ...criterion, ...patch } : criterion,
      ),
    );
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Lists</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        A saved list stores its criteria, not its results, so it stays current as records change.
      </p>

      <section
        aria-labelledby="builder-heading"
        className="mt-6 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
      >
        <h2
          id="builder-heading"
          className="text-base font-semibold text-slate-900 dark:text-slate-50"
        >
          Build a list
        </h2>

        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="builder-entity"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Records
            </label>
            <select
              id="builder-entity"
              value={entity}
              onChange={(event) => {
                setEntity(event.target.value as typeof entity);
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="contact">Contacts</option>
              <option value="company">Companies</option>
              <option value="opportunity">Opportunities</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="builder-join"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Match
            </label>
            <select
              id="builder-join"
              value={join}
              onChange={(event) => {
                setJoin(event.target.value as 'and' | 'or');
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="and">All criteria</option>
              <option value="or">Any criterion</option>
            </select>
          </div>
        </div>

        <ol className="mt-5 flex flex-col gap-4">
          {criteria.map((criterion, index) => (
            <li
              key={index}
              className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`field-${String(index)}`}
                    className="text-xs font-medium text-slate-800 dark:text-slate-200"
                  >
                    Field
                  </label>
                  <select
                    id={`field-${String(index)}`}
                    value={criterion.field}
                    onChange={(event) => {
                      update(index, { field: event.target.value as FilterField });
                    }}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {FILTER_FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {FIELD_LABELS[field] ?? field}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`operator-${String(index)}`}
                    className="text-xs font-medium text-slate-800 dark:text-slate-200"
                  >
                    Comparison
                  </label>
                  <select
                    id={`operator-${String(index)}`}
                    value={criterion.operator}
                    onChange={(event) => {
                      update(index, { operator: event.target.value as FilterOperator });
                    }}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {FILTER_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {OPERATOR_LABELS[operator]}
                      </option>
                    ))}
                  </select>
                </div>

                {/* The value input disappears for the presence operators, which
                    take none (F2.6). */}
                {operatorTakesValue(criterion.operator) && (
                  <Field
                    label={criterion.operator === 'in' ? 'Values (comma-separated)' : 'Value'}
                    name={`value-${String(index)}`}
                    value={criterion.value}
                    onChange={(event) => {
                      update(index, { value: event.target.value });
                    }}
                  />
                )}
              </div>

              {criterion.field === 'customField' && (
                <div className="mt-3">
                  <Field
                    label="Custom field key"
                    name={`key-${String(index)}`}
                    required
                    value={criterion.key}
                    onChange={(event) => {
                      update(index, { key: event.target.value });
                    }}
                  />
                </div>
              )}

              {criterion.operator === 'between' && (
                <div className="mt-3">
                  <Field
                    label="Up to"
                    name={`value-to-${String(index)}`}
                    value={criterion.valueTo}
                    onChange={(event) => {
                      update(index, { valueTo: event.target.value });
                    }}
                  />
                </div>
              )}

              {criteria.length > 1 && (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={`Remove criterion ${String(index + 1)}`}
                    onClick={() => {
                      setCriteria((current) => current.filter((_, position) => position !== index));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setCriteria((current) => [...current, EMPTY_CRITERION]);
            }}
          >
            Add criterion
          </Button>
          <Button
            type="button"
            variant="secondary"
            busy={runFilter.isPending}
            onClick={() => {
              runFilter.mutate({ entity, filter });
            }}
          >
            Preview
          </Button>
        </div>

        <div aria-live="polite" className="mt-4">
          <Alert error={runFilter.error} />
          {runFilter.data !== undefined && (
            <Notice>
              {runFilter.data.pageInfo.total} matching{' '}
              {runFilter.data.pageInfo.total === 1 ? 'record' : 'records'}.
            </Notice>
          )}
        </div>

        <form
          noValidate
          className="mt-5 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-5 dark:border-slate-700"
          onSubmit={(event) => {
            event.preventDefault();
            createList.mutate(
              { name: name.trim(), entity, filter },
              {
                onSuccess: () => {
                  setName('');
                },
              },
            );
          }}
        >
          <div className="min-w-0 flex-1">
            <Field
              label="Save this list as"
              name="listName"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <Button type="submit" busy={createList.isPending} busyLabel="Saving…">
            Save list
          </Button>
        </form>

        <div aria-live="polite" className="mt-3">
          <Alert error={createList.error} />
          {createList.isSuccess && <Notice>List saved.</Notice>}
        </div>
      </section>

      <section aria-labelledby="saved-heading" className="mt-8">
        <h2
          id="saved-heading"
          className="text-base font-semibold text-slate-900 dark:text-slate-50"
        >
          Saved lists
        </h2>

        <div aria-live="polite" className="mt-3">
          <Alert error={savedLists.error} />
          <Alert error={deleteList.error} />
        </div>

        {(savedLists.data?.savedLists ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">No saved lists yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {(savedLists.data?.savedLists ?? []).map((list) => (
              <li
                key={list.id}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium break-words text-slate-900 dark:text-slate-100">
                      {list.name}
                    </span>
                    <span className="ml-2 text-xs text-slate-600 dark:text-slate-400">
                      {list.entity} · {list.filter.criteria.length} criteria
                    </span>
                  </span>

                  <span className="flex gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setOpenListId((current) => (current === list.id ? null : list.id));
                      }}
                    >
                      {openListId === list.id ? 'Close' : 'Open'}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      busy={deleteList.isPending}
                      onClick={() => {
                        deleteList.mutate(list.id);
                        setOpenListId((current) => (current === list.id ? null : current));
                      }}
                    >
                      Delete
                    </Button>
                  </span>
                </div>

                {openListId === list.id && (
                  <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
                    {openList.isPending && (
                      <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
                        Running the list…
                      </p>
                    )}
                    <Alert error={openList.error} />
                    {openList.data !== undefined && (
                      <>
                        <p className="text-sm text-slate-600 dark:text-slate-400">
                          {openList.data.pageInfo.total} matching{' '}
                          {openList.data.pageInfo.total === 1 ? 'record' : 'records'}, re-run just
                          now.
                        </p>
                        <ul className="mt-2 flex flex-col gap-1 text-sm">
                          {openList.data.items.map((item) => (
                            <li
                              key={String(item['id'])}
                              className="break-words text-slate-900 dark:text-slate-100"
                            >
                              {describeRecord(item)}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
