import { isRequiredInStage, type CustomFieldDefinition } from '@ubmp/domain';
import { useId } from 'react';

import { Field } from '../../components/Field.js';
import type { CustomField } from './crm-api.js';

/**
 * Renders a form from custom field *definitions* (F2.2).
 *
 * Nothing here knows which fields exist: the definitions come from the server,
 * so a field an Admin adds appears on the next load with no code change. The
 * input type is chosen from the definition's type, and the same `required` rule
 * the server applies decides the marker, so the form cannot ask for less than
 * the server will demand (F2.4).
 */
export interface CustomFieldInputsProps {
  readonly definitions: readonly CustomField[];
  readonly values: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
  /** The stage the record is in or moving into, for stage-required fields. */
  readonly stageId?: string | null;
  /** Field-level errors the server reported, keyed by field key. */
  readonly errors?: Record<string, string> | undefined;
  readonly disabled?: boolean;
}

function toDomain(definition: CustomField): CustomFieldDefinition {
  return {
    key: definition.key,
    label: definition.label,
    type: definition.type,
    options: definition.options,
    required: definition.required,
    requiredInStageIds: definition.requiredInStageIds,
  };
}

export function CustomFieldInputs({
  definitions,
  values,
  onChange,
  stageId = null,
  errors,
  disabled = false,
}: CustomFieldInputsProps) {
  if (definitions.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {definitions.map((definition) => (
        <CustomFieldInput
          key={definition.key}
          definition={definition}
          value={values[definition.key]}
          required={isRequiredInStage(toDomain(definition), stageId)}
          error={errors?.[definition.key]}
          disabled={disabled}
          onChange={(value) => {
            onChange(definition.key, value);
          }}
        />
      ))}
    </div>
  );
}

interface CustomFieldInputProps {
  readonly definition: CustomField;
  readonly value: unknown;
  readonly required: boolean;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
}

function CustomFieldInput({
  definition,
  value,
  required,
  error,
  disabled,
  onChange,
}: CustomFieldInputProps) {
  const id = useId();

  switch (definition.type) {
    case 'text':
      return (
        <Field
          label={definition.label}
          name={definition.key}
          type="text"
          required={required}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          error={error}
          onChange={(event) => {
            onChange(event.target.value === '' ? null : event.target.value);
          }}
        />
      );

    case 'number':
      return (
        <Field
          label={definition.label}
          name={definition.key}
          type="number"
          required={required}
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          error={error}
          onChange={(event) => {
            // An empty input clears the field rather than sending NaN.
            onChange(event.target.value === '' ? null : Number(event.target.value));
          }}
        />
      );

    case 'date':
      return (
        <Field
          label={definition.label}
          name={definition.key}
          type="date"
          required={required}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          error={error}
          hint="YYYY-MM-DD"
          onChange={(event) => {
            onChange(event.target.value === '' ? null : event.target.value);
          }}
        />
      );

    case 'dropdown':
      return (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">
            {definition.label}
            {required && (
              <span aria-hidden="true" className="ml-1 text-red-700 dark:text-red-400">
                *
              </span>
            )}
          </label>
          <select
            id={id}
            name={definition.key}
            required={required}
            disabled={disabled}
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : `${id}-error`}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => {
              onChange(event.target.value === '' ? null : event.target.value);
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none disabled:opacity-60 aria-invalid:border-red-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">Not set</option>
            {definition.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {error !== undefined && (
            <p id={`${id}-error`} className="text-xs font-medium text-red-700 dark:text-red-400">
              <span aria-hidden="true">! </span>
              {error}
            </p>
          )}
        </div>
      );

    case 'checkbox':
      return (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
            <input
              type="checkbox"
              name={definition.key}
              disabled={disabled}
              checked={value === true}
              aria-describedby={error === undefined ? undefined : `${id}-error`}
              onChange={(event) => {
                onChange(event.target.checked);
              }}
              className="focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
            />
            {definition.label}
          </label>
          {error !== undefined && (
            <p id={`${id}-error`} className="text-xs font-medium text-red-700 dark:text-red-400">
              <span aria-hidden="true">! </span>
              {error}
            </p>
          )}
        </div>
      );
  }
}
