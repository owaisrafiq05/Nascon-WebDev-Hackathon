import { z } from 'zod';

/**
 * Every list endpoint is paginated with the same contract so that lists of several
 * hundred records stay responsive (Q9) and the web app can reuse one hook.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PageInfo {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly pageInfo: PageInfo;
}

/** Number of documents to skip for a 1-based page. */
export function offsetFor({ page, limit }: PaginationQuery): number {
  return (page - 1) * limit;
}

export function paginate<T>(
  items: readonly T[],
  { page, limit }: PaginationQuery,
  total: number,
): Paginated<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    items,
    pageInfo: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && totalPages > 0,
    },
  };
}
