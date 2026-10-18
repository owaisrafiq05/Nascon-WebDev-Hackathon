import { describe, expect, it } from 'vitest';

import {
  criterionPath,
  EMPTY_FILTER,
  FILTER_PROBLEMS,
  type Filter,
  type FilterCriterion,
  matchesCriterion,
  matchesFilter,
  MAX_FILTER_CRITERIA,
  operatorTakesValue,
  validateFilter,
} from './filters.js';

const contact = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+15550101',
  tags: ['vip', 'roof'],
  companyId: 'company-1',
  ownerMembershipId: 'member-1',
  createdAt: new Date('2026-03-01T00:00:00Z'),
  lastActivityAt: null,
  customFields: { area: 120, tier: 'gold', surveyed: false },
};

function criterion(overrides: Partial<FilterCriterion> = {}): FilterCriterion {
  return { field: 'name', operator: 'eq', value: 'Ada Lovelace', ...overrides };
}

describe('criterionPath', () => {
  it('maps each field to its document path', () => {
    expect(criterionPath(criterion({ field: 'tag' }))).toBe('tags');
    expect(criterionPath(criterion({ field: 'company' }))).toBe('companyId');
    expect(criterionPath(criterion({ field: 'owner' }))).toBe('ownerMembershipId');
    expect(criterionPath(criterion({ field: 'stage' }))).toBe('stageId');
  });

  it('addresses a custom field by its key', () => {
    expect(criterionPath(criterion({ field: 'customField', key: 'area' }))).toBe(
      'customFields.area',
    );
  });
});

describe('matchesCriterion equality', () => {
  it('matches a scalar field', () => {
    expect(matchesCriterion(contact, criterion())).toBe(true);
    expect(matchesCriterion(contact, criterion({ value: 'Someone Else' }))).toBe(false);
  });

  it('matches an array field when it contains the value', () => {
    expect(matchesCriterion(contact, criterion({ field: 'tag', value: 'vip' }))).toBe(true);
    expect(matchesCriterion(contact, criterion({ field: 'tag', value: 'cold' }))).toBe(false);
  });

  it('inverts for ne, including on an array field', () => {
    expect(matchesCriterion(contact, criterion({ operator: 'ne', value: 'Someone' }))).toBe(true);
    expect(
      matchesCriterion(contact, criterion({ field: 'tag', operator: 'ne', value: 'vip' })),
    ).toBe(false);
  });

  it('compares a Date against an ISO string', () => {
    expect(
      matchesCriterion(contact, {
        field: 'createdAt',
        operator: 'gte',
        value: '2026-02-01T00:00:00Z',
      }),
    ).toBe(true);
  });
});

describe('matchesCriterion contains', () => {
  it('is case-insensitive on a string field', () => {
    expect(matchesCriterion(contact, criterion({ operator: 'contains', value: 'LOVELACE' }))).toBe(
      true,
    );
  });

  it('searches inside an array of strings', () => {
    expect(matchesCriterion(contact, { field: 'tag', operator: 'contains', value: 'oo' })).toBe(
      true,
    );
  });

  it('is false for a non-string comparison value', () => {
    expect(matchesCriterion(contact, criterion({ operator: 'contains', value: 7 }))).toBe(false);
  });
});

describe('matchesCriterion in', () => {
  it('matches when the value is one of the list', () => {
    expect(
      matchesCriterion(contact, {
        field: 'owner',
        operator: 'in',
        value: ['member-1', 'member-2'],
      }),
    ).toBe(true);
  });

  it('matches when an array field overlaps the list', () => {
    expect(
      matchesCriterion(contact, { field: 'tag', operator: 'in', value: ['cold', 'roof'] }),
    ).toBe(true);
  });

  it('is false when nothing overlaps', () => {
    expect(matchesCriterion(contact, { field: 'tag', operator: 'in', value: ['cold'] })).toBe(
      false,
    );
  });
});

describe('matchesCriterion ranges', () => {
  const area = (operator: FilterCriterion['operator'], value: unknown): FilterCriterion => ({
    field: 'customField',
    key: 'area',
    operator,
    value,
  });

  it('compares numbers', () => {
    expect(matchesCriterion(contact, area('gt', 100))).toBe(true);
    expect(matchesCriterion(contact, area('gt', 200))).toBe(false);
    expect(matchesCriterion(contact, area('gte', 120))).toBe(true);
    expect(matchesCriterion(contact, area('lt', 200))).toBe(true);
    expect(matchesCriterion(contact, area('lte', 120))).toBe(true);
  });

  it('matches a value inside a range, inclusive', () => {
    expect(matchesCriterion(contact, area('between', [100, 150]))).toBe(true);
    expect(matchesCriterion(contact, area('between', [120, 120]))).toBe(true);
    expect(matchesCriterion(contact, area('between', [130, 150]))).toBe(false);
  });

  it('is false for a malformed range rather than throwing', () => {
    expect(matchesCriterion(contact, area('between', [100]))).toBe(false);
    expect(matchesCriterion(contact, area('between', 'nope'))).toBe(false);
  });

  it('is false when the attribute is not comparable', () => {
    expect(matchesCriterion(contact, criterion({ operator: 'gt', value: 5 }))).toBe(false);
  });

  it('compares dates as instants', () => {
    expect(
      matchesCriterion(contact, {
        field: 'createdAt',
        operator: 'between',
        value: ['2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'],
      }),
    ).toBe(true);
  });
});

describe('matchesCriterion isSet and isNotSet', () => {
  it('treats null, undefined and empty string as not set', () => {
    expect(matchesCriterion(contact, { field: 'lastActivityAt', operator: 'isNotSet' })).toBe(true);
    expect(matchesCriterion(contact, { field: 'lastActivityAt', operator: 'isSet' })).toBe(false);
    expect(matchesCriterion({ ...contact, email: '' }, { field: 'email', operator: 'isSet' })).toBe(
      false,
    );
  });

  it('treats a non-empty value as set', () => {
    expect(matchesCriterion(contact, { field: 'email', operator: 'isSet' })).toBe(true);
  });

  it('treats an empty array as not set', () => {
    expect(matchesCriterion({ ...contact, tags: [] }, { field: 'tag', operator: 'isSet' })).toBe(
      false,
    );
    expect(matchesCriterion(contact, { field: 'tag', operator: 'isSet' })).toBe(true);
  });

  it('treats a false checkbox as set, because false is an answer', () => {
    expect(
      matchesCriterion(contact, { field: 'customField', key: 'surveyed', operator: 'isSet' }),
    ).toBe(true);
  });

  it('is not set for a missing custom field', () => {
    expect(
      matchesCriterion(contact, { field: 'customField', key: 'absent', operator: 'isNotSet' }),
    ).toBe(true);
  });
});

describe('matchesFilter', () => {
  it('matches everything for an empty filter, so a list with no criteria is the full list', () => {
    expect(matchesFilter(contact, EMPTY_FILTER)).toBe(true);
  });

  it('requires every criterion with and', () => {
    const filter: Filter = {
      join: 'and',
      criteria: [
        { field: 'tag', operator: 'eq', value: 'vip' },
        { field: 'customField', key: 'area', operator: 'gte', value: 100 },
        { field: 'owner', operator: 'eq', value: 'member-1' },
      ],
    };

    expect(matchesFilter(contact, filter)).toBe(true);

    // Three criteria, one of which now fails (F2.6 asks for at least three).
    expect(
      matchesFilter(contact, {
        ...filter,
        criteria: [...filter.criteria, { field: 'email', operator: 'contains', value: 'nope' }],
      }),
    ).toBe(false);
  });

  it('requires only one criterion with or', () => {
    const filter: Filter = {
      join: 'or',
      criteria: [
        { field: 'tag', operator: 'eq', value: 'cold' },
        { field: 'owner', operator: 'eq', value: 'member-1' },
      ],
    };

    expect(matchesFilter(contact, filter)).toBe(true);
  });

  it('starts and stops matching as the record changes', () => {
    // This is what makes a saved list update automatically (F2.6).
    const filter: Filter = {
      join: 'and',
      criteria: [{ field: 'tag', operator: 'eq', value: 'vip' }],
    };

    expect(matchesFilter(contact, filter)).toBe(true);
    expect(matchesFilter({ ...contact, tags: ['roof'] }, filter)).toBe(false);
    expect(matchesFilter({ ...contact, tags: ['roof', 'vip'] }, filter)).toBe(true);
  });
});

describe('operatorTakesValue', () => {
  it('is false for the presence operators, so a builder hides the input', () => {
    expect(operatorTakesValue('isSet')).toBe(false);
    expect(operatorTakesValue('isNotSet')).toBe(false);
    expect(operatorTakesValue('eq')).toBe(true);
  });
});

describe('validateFilter', () => {
  const valid = (criteria: FilterCriterion[]): Filter => ({ join: 'and', criteria });

  it('accepts a well-formed filter', () => {
    expect(
      validateFilter(
        valid([
          { field: 'tag', operator: 'eq', value: 'vip' },
          { field: 'customField', key: 'area', operator: 'between', value: [1, 2] },
          { field: 'email', operator: 'isSet' },
        ]),
      ),
    ).toEqual([]);
  });

  it('rejects an unknown field or operator', () => {
    expect(
      validateFilter(valid([{ field: 'secret' as 'name', operator: 'eq', value: 'x' }])),
    ).toEqual([{ index: 0, problem: FILTER_PROBLEMS.UNKNOWN_FIELD }]);

    expect(
      validateFilter(valid([{ field: 'name', operator: 'regex' as 'eq', value: 'x' }])),
    ).toEqual([{ index: 0, problem: FILTER_PROBLEMS.UNKNOWN_OPERATOR }]);
  });

  it('requires a key for a custom field criterion', () => {
    expect(validateFilter(valid([{ field: 'customField', operator: 'eq', value: 1 }]))).toEqual([
      { index: 0, problem: FILTER_PROBLEMS.MISSING_CUSTOM_FIELD_KEY },
    ]);
  });

  it('refuses a custom field key that could reach into the query language', () => {
    // The key is interpolated into a document path, so `$` and `.` must not
    // get through.
    for (const key of ['$where', 'a.b', 'Area']) {
      expect(
        validateFilter(valid([{ field: 'customField', key, operator: 'eq', value: 1 }])),
      ).toEqual([{ index: 0, problem: FILTER_PROBLEMS.UNSAFE_CUSTOM_FIELD_KEY }]);
    }
  });

  it('requires a value for an operator that compares', () => {
    expect(validateFilter(valid([{ field: 'name', operator: 'eq' }]))).toEqual([
      { index: 0, problem: FILTER_PROBLEMS.MISSING_VALUE },
    ]);
  });

  it('does not require a value for isSet', () => {
    expect(validateFilter(valid([{ field: 'name', operator: 'isSet' }]))).toEqual([]);
  });

  it('requires two values for between and an array for in', () => {
    expect(validateFilter(valid([{ field: 'value', operator: 'between', value: [1] }]))).toEqual([
      { index: 0, problem: FILTER_PROBLEMS.BETWEEN_NEEDS_TWO },
    ]);

    expect(validateFilter(valid([{ field: 'tag', operator: 'in', value: 'vip' }]))).toEqual([
      { index: 0, problem: FILTER_PROBLEMS.IN_NEEDS_ARRAY },
    ]);
  });

  it('reports the index of each bad criterion', () => {
    const issues = validateFilter(
      valid([
        { field: 'tag', operator: 'eq', value: 'vip' },
        { field: 'name', operator: 'eq' },
      ]),
    );

    expect(issues).toEqual([{ index: 1, problem: FILTER_PROBLEMS.MISSING_VALUE }]);
  });

  it('refuses a filter long enough to be a slow query', () => {
    const criteria = Array.from({ length: MAX_FILTER_CRITERIA + 1 }, () => ({
      field: 'tag' as const,
      operator: 'eq' as const,
      value: 'vip',
    }));

    expect(validateFilter(valid(criteria))).toContainEqual({
      index: -1,
      problem: FILTER_PROBLEMS.TOO_MANY_CRITERIA,
    });
  });
});
