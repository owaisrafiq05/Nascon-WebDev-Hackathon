import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  offsetFor,
  paginate,
  paginationQuerySchema,
} from './pagination.js';

describe('paginationQuerySchema', () => {
  it('defaults to page 1 and the default page size', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE });
  });

  it('coerces the query string values Express provides', () => {
    expect(paginationQuerySchema.parse({ page: '3', limit: '50' })).toEqual({
      page: 3,
      limit: 50,
    });
  });

  it('rejects a limit above the maximum so one caller cannot pull the whole table', () => {
    expect(paginationQuerySchema.safeParse({ limit: MAX_PAGE_SIZE + 1 }).success).toBe(false);
  });

  it('rejects a page below 1 and a non-integer page', () => {
    expect(paginationQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ page: 1.5 }).success).toBe(false);
  });
});

describe('offsetFor', () => {
  it('is 0 on the first page', () => {
    expect(offsetFor({ page: 1, limit: 25 })).toBe(0);
  });

  it('skips the preceding pages', () => {
    expect(offsetFor({ page: 4, limit: 25 })).toBe(75);
  });
});

describe('paginate', () => {
  it('reports the surrounding pages for a middle page', () => {
    const result = paginate(['a', 'b'], { page: 2, limit: 2 }, 5);

    expect(result.pageInfo).toEqual({
      page: 2,
      limit: 2,
      total: 5,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('has no next page on the last page', () => {
    expect(paginate(['e'], { page: 3, limit: 2 }, 5).pageInfo.hasNextPage).toBe(false);
  });

  it('reports no pages at all for an empty result', () => {
    const { pageInfo } = paginate([], { page: 1, limit: 25 }, 0);

    expect(pageInfo.totalPages).toBe(0);
    expect(pageInfo.hasNextPage).toBe(false);
    expect(pageInfo.hasPreviousPage).toBe(false);
  });
});
