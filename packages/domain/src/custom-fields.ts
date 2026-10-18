import { z } from 'zod';

/**
 * Custom field definitions and the validation generated from them (F2.2, F2.4).
 *
 * A workspace adds fields through the interface, so the rules for what a field
 * accepts cannot be written as code at build time. They are derived from the
 * stored definitions at runtime instead, by this module.
 *
 * It lives in the domain, with no I/O, because both sides need it: the server
 * validates a submitted value against the definitions, and the web app renders
 * and pre-validates the same form from the same definitions. One source means
 * the interface cannot accept something the server will reject (Q12).
 */

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'dropdown', 'checkbox'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return typeof value === 'string' && (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);
}

/** Which kind of record a definition belongs to. */
export const CUSTOM_FIELD_ENTITIES = ['contact', 'company', 'opportunity'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export interface CustomFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  /** Choices for `dropdown`. Empty for every other type. */
  readonly options: readonly string[];
  /** Required whenever the record is saved. */
  readonly required: boolean;
  /**
   * Stages that require this field before an opportunity may enter them
   * (F2.4). Empty for a field with no stage condition.
   */
  readonly requiredInStageIds: readonly string[];
}

/**
 * A field key must be a safe identifier: it becomes a key inside a stored
 * object and a form field name, so a leading `$` or an embedded `.` would be
 * read by MongoDB as an operator or a path.
 */
export const customFieldKeySchema = z
  .string()
  .min(1, 'is required')
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'must start with a letter and use only lowercase, digits and _');

export function isValidCustomFieldKey(key: string): boolean {
  return customFieldKeySchema.safeParse(key).success;
}

/**
 * Whether a definition must have a value for a record in `stageId`.
 *
 * `required` applies always; `requiredInStageIds` applies only when the record
 * is entering, or sitting in, one of those stages.
 */
export function isRequiredInStage(
  definition: CustomFieldDefinition,
  stageId: string | null,
): boolean {
  if (definition.required) return true;
  if (stageId === null) return false;

  return definition.requiredInStageIds.includes(stageId);
}

/** The value schema for one definition, before optionality is applied. */
function valueSchema(definition: CustomFieldDefinition): z.ZodType {
  switch (definition.type) {
    case 'text':
      return z.string().max(5_000);
    case 'number':
      // Finite: NaN and Infinity survive JSON round-trips as `null`, and would
      // otherwise poison any total computed from the column.
      return z.number().finite();
    case 'date':
      // Stored as an ISO date string, so it sorts lexicographically and carries
      // no implied time zone the way a bare Date would.
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD');
    case 'dropdown':
      // A dropdown with no options can hold nothing; `z.never()` says so rather
      // than quietly accepting any string.
      return definition.options.length === 0
        ? z.never()
        : z.enum([...definition.options] as [string, ...string[]]);
    case 'checkbox':
      return z.boolean();
  }
}

export interface BuildCustomFieldSchemaOptions {
  /**
   * The stage the record is in or moving into. Fields listed in that stage's
   * `requiredInStageIds` become required (F2.4).
   */
  readonly stageId?: string | null | undefined;
  /**
   * When true, a field absent from the payload is left alone rather than
   * treated as missing. Used for a partial edit, where the caller sends only
   * what changed; a stage move always validates in full.
   */
  readonly partial?: boolean | undefined;
}

/**
 * Builds the Zod schema for a set of definitions.
 *
 * Unknown keys are stripped rather than rejected, so a field deleted while a
 * form was open does not fail the save with a message about a field that no
 * longer exists.
 */
export function buildCustomFieldSchema(
  definitions: readonly CustomFieldDefinition[],
  options: BuildCustomFieldSchemaOptions = {},
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};

  for (const definition of definitions) {
    const base = valueSchema(definition);
    const required = isRequiredInStage(definition, options.stageId ?? null);

    if (required && options.partial !== true) {
      shape[definition.key] = base;
    } else {
      // A cleared value is `null`, which is distinct from "not sent".
      shape[definition.key] = base.nullish().optional();
    }
  }

  return z.object(shape).strip();
}

/** One field that must be filled before the record can be saved or moved. */
export interface MissingRequiredField {
  readonly key: string;
  /** The label a person sees, so the message names the field they recognise. */
  readonly label: string;
}

/**
 * The required fields a record has not filled, for the stage-move check (F2.4).
 *
 * A value counts as missing when it is absent, `null`, or an empty string. An
 * unticked checkbox (`false`) and a zero are *present*: refusing them would
 * make "required" impossible to satisfy for a legitimate answer.
 */
export function missingRequiredFields(
  definitions: readonly CustomFieldDefinition[],
  values: Record<string, unknown>,
  stageId: string | null,
): readonly MissingRequiredField[] {
  return definitions
    .filter((definition) => isRequiredInStage(definition, stageId))
    .filter((definition) => {
      const value = values[definition.key];
      return value === undefined || value === null || value === '';
    })
    .map((definition) => ({ key: definition.key, label: definition.label }));
}

/**
 * The message shown when a stage move is blocked (F2.4): "a clear message,
 * until its required fields are filled".
 */
export function missingFieldsMessage(
  stageName: string,
  missing: readonly MissingRequiredField[],
): string {
  const labels = missing.map((field) => field.label);
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;

  return `Fill in ${String(list)} before moving this to ${stageName}.`;
}
