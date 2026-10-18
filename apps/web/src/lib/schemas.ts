import { z } from 'zod';

/** Shared response pieces: pagination and a helper for paginated lists. */
export const pageInfoSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
  hasNextPage: z.boolean().optional(),
  hasPreviousPage: z.boolean().optional(),
});

export type PageInfo = z.infer<typeof pageInfoSchema>;

export function paged<TItem extends z.ZodType>(item: TItem) {
  return z.object({ items: z.array(item), pageInfo: pageInfoSchema });
}
