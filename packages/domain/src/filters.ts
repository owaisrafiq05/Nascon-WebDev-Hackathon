/**
 * The filter query DSL behind filtering and saved lists (F2.6).
 *
 * A saved list stores this structure, not a result set. The requirement is that
 * "the list updates automatically as records start or stop matching", so the
 * query is re-run on every request rather than a membership table being
 * maintained — nothing can then go stale, and a record edited by any path is
 * reflected at once.
 *
 * The DSL is declared here, in the domain, because three things must agree on
 * it: the builder that writes a filter, the repository that turns it into a
 * database query, and this module's `matchesFilter`, which decides membership
 * for a single record without a round trip.
 */

/** The record attributes a filter may test. */
export const FILTER_FIELDS = [
  'name',
  'email',
  'phone',
  'tag',
  'company',
  'owner',
  'stage',
  'stageOutcome',
  'value',
  'createdAt',
  'lastActivityAt',
  /** Any custom field, addressed as `customFields.<key>`. */
  'customField',
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'contains',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isSet',
  'isNotSet',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterCriterion {
  readonly field: FilterField;
  /** Required when `field` is `customField`; the definition's key. */
  readonly key?: string | undefined;
  readonly operator: FilterOperator;
  /**
   * The comparison value. `between` takes a two-element array; `in` takes an
   * array; `isSet` and `isNotSet` take nothing.
   */
  readonly value?: unknown;
}

/**
 * A filter is a list of criteria joined by `and` or `or`.
 *
 * Deliberately flat rather than a nested boolean tree: F2.6 asks for "at least
 * three criteria" combined, which a flat list with one joiner satisfies, and a
 * nested tree would need a query builder UI that no requirement calls for.
 */
export interface Filter {
  readonly join: 'and' | 'or';
  readonly criteria: readonly FilterCriterion[];
}

export const EMPTY_FILTER: Filter = { join: 'and', criteria: [] };

export function isFilterField(value: unknown): value is FilterField {
  return typeof value === 'string' && (FILTER_FIELDS as readonly string[]).includes(value);
}

export function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === 'string' && (FILTER_OPERATORS as readonly string[]).includes(value);
}

/** Operators that take no value, so a builder knows to hide the input. */
export const VALUELESS_OPERATORS: readonly FilterOperator[] = ['isSet', 'isNotSet'];

export function operatorTakesValue(operator: FilterOperator): boolean {
  return !VALUELESS_OPERATORS.includes(operator);
}

/**
 * The attribute path a criterion reads, which is also the document path the
 * repository queries. Keeping the mapping here means the matcher and the
 * database query can never disagree about which field a criterion means.
 */
export function criterionPath(criterion: FilterCriterion): string {
  switch (criterion.field) {
    case 'name':
      return 'name';
    case 'email':
      return 'email';
    case 'phone':
      return 'phone';
    case 'tag':
      return 'tags';
    case 'company':
      return 'companyId';
    case 'owner':
      return 'ownerMembershipId';
    case 'stage':
      return 'stageId';
    case 'stageOutcome':
      return 'stageOutcome';
    case 'value':
      return 'value';
    case 'createdAt':
      return 'createdAt';
    case 'lastActivityAt':
      return 'lastActivityAt';
    case 'customField':
      // Validated by `validateFilter` before it reaches here, so the key
      // cannot carry a `$` or a `.` into the query.
      return `customFields.${criterion.key ?? ''}`;
  }
}

/** Reads a dotted path out of a record, for `matchesFilter`. */
function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;

  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/** Normalises for comparison: ids and dates become comparable primitives. */
function comparable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.getTime();

  if (typeof value === 'object') {
    // An ObjectId's identity is its hex string, so it compares correctly
    // against the string a client sends. Anything whose `toString` is still
    // Object's would stringify to "[object Object]" and compare as equal to
    // every other such value, so it is left alone instead.
    const candidate = value as { toString?: () => string };
    return typeof candidate.toString === 'function' &&
      candidate.toString !== Object.prototype.toString
      ? candidate.toString()
      : value;
  }

  return value;
}

function asNumber(value: unknown): number | undefined {
  const normalised = comparable(value);
  if (typeof normalised === 'number') return normalised;
  if (typeof normalised === 'string') {
    // An ISO date string orders correctly as a timestamp.
    const parsed = Date.parse(normalised);
    if (!Number.isNaN(parsed)) return parsed;
    const asFloat = Number(normalised);
    return Number.isNaN(asFloat) ? undefined : asFloat;
  }
  return undefined;
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Whether one criterion matches one record.
 *
 * Used to decide membership without a database round trip: the saved-list tests
 * assert that a record starts and stops matching as it is edited, and a
 * realtime update in P5 needs the same answer for a single record.
 */
export function matchesCriterion(
  record: Record<string, unknown>,
  criterion: FilterCriterion,
): boolean {
  const actual = readPath(record, criterionPath(criterion));

  switch (criterion.operator) {
    case 'isSet':
      return Array.isArray(actual) ? actual.length > 0 : !isMissing(actual);
    case 'isNotSet':
      return Array.isArray(actual) ? actual.length === 0 : isMissing(actual);

    case 'eq':
      // An array attribute (tags) matches when it contains the value, which is
      // what MongoDB does for an equality test against an array field.
      return Array.isArray(actual)
        ? actual.map(comparable).includes(comparable(criterion.value))
        : comparable(actual) === comparable(criterion.value);

    case 'ne':
      return Array.isArray(actual)
        ? !actual.map(comparable).includes(comparable(criterion.value))
        : comparable(actual) !== comparable(criterion.value);

    case 'contains': {
      if (typeof criterion.value !== 'string') return false;
      const needle = criterion.value.toLowerCase();

      if (Array.isArray(actual)) {
        return actual.some(
          (entry) => typeof entry === 'string' && entry.toLowerCase().includes(needle),
        );
      }

      return typeof actual === 'string' && actual.toLowerCase().includes(needle);
    }

    case 'in': {
      if (!Array.isArray(criterion.value)) return false;
      const wanted = criterion.value.map(comparable);

      return Array.isArray(actual)
        ? actual.map(comparable).some((entry) => wanted.includes(entry))
        : wanted.includes(comparable(actual));
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = asNumber(actual);
      const right = asNumber(criterion.value);
      if (left === undefined || right === undefined) return false;

      if (criterion.operator === 'gt') return left > right;
      if (criterion.operator === 'gte') return left >= right;
      if (criterion.operator === 'lt') return left < right;
      return left <= right;
    }

    case 'between': {
      if (!Array.isArray(criterion.value) || criterion.value.length !== 2) return false;
      const left = asNumber(actual);
      const from = asNumber(criterion.value[0]);
      const to = asNumber(criterion.value[1]);
      if (left === undefined || from === undefined || to === undefined) return false;

      return left >= from && left <= to;
    }
  }
}

/**
 * Whether a record matches the whole filter.
 *
 * An empty filter matches everything, so a saved list with no criteria is the
 * full list rather than an empty one.
 */
export function matchesFilter(record: Record<string, unknown>, filter: Filter): boolean {
  if (filter.criteria.length === 0) return true;

  return filter.join === 'and'
    ? filter.criteria.every((criterion) => matchesCriterion(record, criterion))
    : filter.criteria.some((criterion) => matchesCriterion(record, criterion));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const FILTER_PROBLEMS = {
  UNKNOWN_FIELD: 'unknown_field',
  UNKNOWN_OPERATOR: 'unknown_operator',
  MISSING_CUSTOM_FIELD_KEY: 'missing_custom_field_key',
  UNSAFE_CUSTOM_FIELD_KEY: 'unsafe_custom_field_key',
  MISSING_VALUE: 'missing_value',
  BETWEEN_NEEDS_TWO: 'between_needs_two',
  IN_NEEDS_ARRAY: 'in_needs_array',
  TOO_MANY_CRITERIA: 'too_many_criteria',
} as const;

export type FilterProblem = (typeof FILTER_PROBLEMS)[keyof typeof FILTER_PROBLEMS];

export interface FilterValidationIssue {
  /** Which criterion, so a builder can mark the offending row. */
  readonly index: number;
  readonly problem: FilterProblem;
}

/** A filter longer than this is refused rather than turned into a slow query. */
export const MAX_FILTER_CRITERIA = 20;

/**
 * Checks a filter before it is stored or executed.
 *
 * The custom field key is the security-relevant part: it is interpolated into a
 * document path, so anything other than a plain identifier is refused here
 * rather than reaching the query.
 */
export function validateFilter(filter: Filter): readonly FilterValidationIssue[] {
  const issues: FilterValidationIssue[] = [];

  if (filter.criteria.length > MAX_FILTER_CRITERIA) {
    issues.push({ index: -1, problem: FILTER_PROBLEMS.TOO_MANY_CRITERIA });
  }

  filter.criteria.forEach((criterion, index) => {
    if (!isFilterField(criterion.field)) {
      issues.push({ index, problem: FILTER_PROBLEMS.UNKNOWN_FIELD });
      return;
    }
    if (!isFilterOperator(criterion.operator)) {
      issues.push({ index, problem: FILTER_PROBLEMS.UNKNOWN_OPERATOR });
      return;
    }

    if (criterion.field === 'customField') {
      if (criterion.key === undefined || criterion.key === '') {
        issues.push({ index, problem: FILTER_PROBLEMS.MISSING_CUSTOM_FIELD_KEY });
        return;
      }
      if (!/^[a-z][a-z0-9_]*$/.test(criterion.key)) {
        issues.push({ index, problem: FILTER_PROBLEMS.UNSAFE_CUSTOM_FIELD_KEY });
        return;
      }
    }

    if (!operatorTakesValue(criterion.operator)) return;

    if (criterion.value === undefined) {
      issues.push({ index, problem: FILTER_PROBLEMS.MISSING_VALUE });
      return;
    }

    if (
      criterion.operator === 'between' &&
      (!Array.isArray(criterion.value) || criterion.value.length !== 2)
    ) {
      issues.push({ index, problem: FILTER_PROBLEMS.BETWEEN_NEEDS_TWO });
    }

    if (criterion.operator === 'in' && !Array.isArray(criterion.value)) {
      issues.push({ index, problem: FILTER_PROBLEMS.IN_NEEDS_ARRAY });
    }
  });

  return issues;
}

/** A human-readable reason, for the message a builder shows (Q10). */
export function describeFilterProblem(problem: FilterProblem): string {
  const messages: Record<FilterProblem, string> = {
    unknown_field: 'That field cannot be filtered on.',
    unknown_operator: 'That comparison is not supported.',
    missing_custom_field_key: 'Choose which custom field to filter on.',
    unsafe_custom_field_key: 'That custom field name is not valid.',
    missing_value: 'Enter a value to compare against.',
    between_needs_two: 'A range needs a start and an end.',
    in_needs_array: 'That comparison needs a list of values.',
    too_many_criteria: `A list can combine at most ${String(MAX_FILTER_CRITERIA)} criteria.`,
  };

  return messages[problem];
}
