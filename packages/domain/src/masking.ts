import { hasPermission, type Permission, PERMISSIONS } from './permissions.js';

/**
 * Field-level protection for opportunity value (F1.4).
 *
 * The rule lives here, as one function, because F1.4 requires the same hiding in
 * lists, on detail pages *and* in exports. Three code paths each deciding for
 * themselves is how one of them ends up leaking the number. Every read path
 * calls `maskOpportunityValue` on its way out.
 *
 * Masking replaces the value with `null` and sets a flag, rather than sending 0
 * or omitting the key silently. A reader can then tell "no value recorded" from
 * "you may not see this value", and the interface can say which (Q10).
 */

/** The part of an opportunity this rule touches. */
export interface ValuedRecord {
  /** Minor units, or `null` when nothing has been recorded. */
  readonly value: number | null;
  readonly currency: string | null;
}

export type MaskedValue<T extends ValuedRecord> = Omit<T, 'value' | 'currency'> & {
  readonly value: number | null;
  readonly currency: string | null;
  /** True when a value exists but the reader may not see it. */
  readonly valueMasked: boolean;
};

export function canViewOpportunityValue(permissions: ReadonlySet<Permission>): boolean {
  return hasPermission(permissions, PERMISSIONS.OPPORTUNITY_VALUE_VIEW);
}

/**
 * Returns the record with its value removed unless the reader holds
 * `opportunity.value.view`.
 *
 * The currency is removed with the value: on its own it reveals nothing useful,
 * and leaving it in would let an interface render "USD —" as though a value were
 * merely missing.
 */
export function maskOpportunityValue<T extends ValuedRecord>(
  record: T,
  permissions: ReadonlySet<Permission>,
): MaskedValue<T> {
  if (canViewOpportunityValue(permissions)) {
    return { ...record, valueMasked: false };
  }

  return {
    ...record,
    value: null,
    currency: null,
    // Only claim something was hidden when there was something to hide.
    valueMasked: record.value !== null,
  };
}

/** The list and export paths; the same rule applied to many records. */
export function maskOpportunityValues<T extends ValuedRecord>(
  records: readonly T[],
  permissions: ReadonlySet<Permission>,
): readonly MaskedValue<T>[] {
  return records.map((record) => maskOpportunityValue(record, permissions));
}

/** What an export writes in the value column when the reader may not see it. */
export const MASKED_EXPORT_PLACEHOLDER = 'hidden';

/**
 * The cell an export writes for a value. Kept next to the masking rule so a CSV
 * writer cannot reach for `record.value` and bypass it.
 */
export function opportunityValueExportCell(
  record: ValuedRecord,
  permissions: ReadonlySet<Permission>,
): string {
  if (!canViewOpportunityValue(permissions)) return MASKED_EXPORT_PLACEHOLDER;
  if (record.value === null) return '';
  return (record.value / 100).toFixed(2);
}
