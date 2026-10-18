import {
  criterionPath,
  validateFilter,
  type Filter,
  type FilterCriterion,
  describeFilterProblem,
} from '@ubmp/domain';
import { validationFailed } from '@ubmp/shared';
import { Types } from 'mongoose';

/**
 * Turns the domain's filter DSL into a MongoDB query (F2.6).
 *
 * The filter is **validated before compilation, every time**, including when it
 * came out of the database: a saved list is stored data, and a field key reaches
 * a document path, so re-validating is what stops a filter written by an older
 * version of the builder from compiling into something unintended.
 *
 * Only operators from the DSL are ever emitted. A caller cannot supply a raw
 * MongoDB operator, because `compileCriterion` switches on a closed union and
 * builds the expression itself.
 */

/** Raised when a stored or submitted filter cannot be compiled. */
export function assertFilterIsValid(filter: Filter): void {
  const issues = validateFilter(filter);
  if (issues.length === 0) return;

  throw validationFailed('That filter is not valid.', {
    hint: 'Correct the highlighted criteria and try again.',
    details: {
      issues: issues.map((issue) => ({
        index: issue.index,
        problem: issue.problem,
        message: describeFilterProblem(issue.problem),
      })),
    },
  });
}

/** Escapes a value for safe use inside a regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Coerces a comparison value for the field it is compared against.
 *
 * An id arrives as a string but is stored as an ObjectId, and a date arrives as
 * an ISO string but is stored as a Date; without this, both would silently
 * match nothing.
 */
function coerce(criterion: FilterCriterion, value: unknown): unknown {
  if (criterion.field === 'company' || criterion.field === 'owner') {
    return typeof value === 'string' && Types.ObjectId.isValid(value)
      ? new Types.ObjectId(value)
      : value;
  }

  if (criterion.field === 'createdAt' || criterion.field === 'lastActivityAt') {
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date;
    }
  }

  return value;
}

function compileCriterion(criterion: FilterCriterion): Record<string, unknown> {
  const path = criterionPath(criterion);
  const value = coerce(criterion, criterion.value);

  switch (criterion.operator) {
    case 'eq':
      // Equality against an array field matches containment in MongoDB, which
      // is the same rule `matchesCriterion` applies.
      return { [path]: value };
    case 'ne':
      return { [path]: { $ne: value } };

    case 'contains':
      return typeof criterion.value === 'string'
        ? { [path]: { $regex: escapeRegex(criterion.value), $options: 'i' } }
        : // A non-string cannot be a substring; match nothing rather than
          // compiling a pattern from it.
          { _id: { $in: [] } };

    case 'in':
      return {
        [path]: {
          $in: Array.isArray(criterion.value)
            ? criterion.value.map((entry) => coerce(criterion, entry))
            : [],
        },
      };

    case 'gt':
      return { [path]: { $gt: value } };
    case 'gte':
      return { [path]: { $gte: value } };
    case 'lt':
      return { [path]: { $lt: value } };
    case 'lte':
      return { [path]: { $lte: value } };

    case 'between': {
      const range = Array.isArray(criterion.value) ? criterion.value : [];
      return {
        [path]: {
          $gte: coerce(criterion, range[0]),
          $lte: coerce(criterion, range[1]),
        },
      };
    }

    case 'isSet':
      // `$nin` rather than `$exists`, so a stored `null` or empty string counts
      // as not set — the same rule the matcher uses.
      return { [path]: { $nin: [null, ''] } };
    case 'isNotSet':
      return { [path]: { $in: [null, ''] } };
  }
}

/**
 * Compiles a filter into a query fragment.
 *
 * The caller merges it with the tenant scope, so the `workspaceId` is applied
 * where it cannot be overridden by a criterion.
 */
export function compileFilter(filter: Filter): Record<string, unknown> {
  assertFilterIsValid(filter);

  if (filter.criteria.length === 0) return {};

  const compiled = filter.criteria.map(compileCriterion);

  // Always emitted as $and/$or rather than a merged object, so two criteria on
  // the same field cannot overwrite each other.
  return filter.join === 'and' ? { $and: compiled } : { $or: compiled };
}
